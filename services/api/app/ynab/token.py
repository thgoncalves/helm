"""YNAB Personal Access Token storage.

Two backends, selected by env config:

* **Secrets Manager** — used whenever ``HELM_YNAB_SECRET_ARN`` is set.
  The API Lambda owns both read and write; the plaintext token never
  lands in the database or in a Cognito custom attribute. This is the
  deployed-environment path.

* **Local file** — used when the ARN is unset. Token lives on disk at
  ``~/.helm/local/ynab-token`` with ``0600`` perms. This keeps the
  local dev loop usable (paste a PAT into Settings, refresh the
  dashboard) without wiring up Secrets Manager from a laptop, even
  when the rest of ``.env`` points at dev Aurora.

Cached per-process (Lambda warm container) so a single dashboard page
load can fan out to multiple YNAB endpoints without re-fetching the
secret each time. ``put_token`` invalidates the cache so a freshly
rotated token takes effect immediately on the next call.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from app import aws
from app.config import settings


class YnabTokenNotConfigured(RuntimeError):
    """Raised when no backing store is configured (no Secret ARN and not
    running in ``local`` stage)."""


# In-process cache. ``None`` means "not yet checked" — empty string means
# "checked, no token stored". Distinct so tests can monkeypatch.
_CACHED_TOKEN: str | None = None
_CACHE_PRIMED: bool = False


# ---------------------------------------------------------------------------
# Backing-store dispatch — local file vs Secrets Manager
# ---------------------------------------------------------------------------


def _use_local_file() -> bool:
    """Pick the backing store.

    No Secret ARN → on-disk fallback (dev laptop). The check is purely
    on the ARN, NOT on stage: a dev `.env` that points the API at dev
    Aurora but leaves the YNAB ARN unset should still get the local
    file (because deploying the YnabPat secret needs a separate CDK
    deploy that the user may not have run yet).
    """
    return not settings.ynab_secret_arn


def _local_token_path() -> Path:
    """Resolve the on-disk token path for local dev.

    Honours ``HELM_YNAB_LOCAL_TOKEN_FILE`` for tests; defaults to
    ``~/.helm/local/ynab-token``.
    """
    override = os.environ.get("HELM_YNAB_LOCAL_TOKEN_FILE")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".helm" / "local" / "ynab-token"


def _secret_arn() -> str:
    arn = settings.ynab_secret_arn
    if not arn:
        # This branch should be unreachable once _use_local_file() is
        # the dispatch gate, but keep the message useful in case a
        # future caller bypasses the dispatch.
        raise YnabTokenNotConfigured(
            "HELM_YNAB_SECRET_ARN is not set."
        )
    return arn


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load_token() -> str | None:
    """Return the cached YNAB PAT, fetching from the backing store on miss.

    Returns ``None`` when no token has been stored yet.
    """
    global _CACHED_TOKEN, _CACHE_PRIMED
    if _CACHE_PRIMED:
        return _CACHED_TOKEN

    raw = _load_local() if _use_local_file() else _load_from_secrets_manager()

    _CACHED_TOKEN = raw or None
    _CACHE_PRIMED = True
    return _CACHED_TOKEN


def put_token(token: str) -> None:
    """Persist a fresh PAT and invalidate the cache.

    Empty strings are rejected — use :func:`delete_token` to remove a
    token entirely.
    """
    if not token or not token.strip():
        raise ValueError("YNAB token cannot be empty.")

    if _use_local_file():
        _save_local(token.strip())
    else:
        _save_to_secrets_manager(token.strip())

    _invalidate_cache()


def delete_token() -> None:
    """Remove the stored PAT and invalidate the cache."""
    if _use_local_file():
        path = _local_token_path()
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        client = aws.secretsmanager()
        try:
            client.delete_secret(
                SecretId=_secret_arn(),
                ForceDeleteWithoutRecovery=True,
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code not in ("ResourceNotFoundException",):
                raise

    _invalidate_cache()


def _invalidate_cache() -> None:
    global _CACHED_TOKEN, _CACHE_PRIMED
    _CACHED_TOKEN = None
    _CACHE_PRIMED = False


# ---------------------------------------------------------------------------
# Backend: AWS Secrets Manager
# ---------------------------------------------------------------------------


def _load_from_secrets_manager() -> str:
    client = aws.secretsmanager()
    try:
        resp = client.get_secret_value(SecretId=_secret_arn())
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code == "ResourceNotFoundException":
            return ""
        raise
    return _extract_token(resp)


def _save_to_secrets_manager(token: str) -> None:
    client = aws.secretsmanager()
    arn = _secret_arn()
    try:
        client.put_secret_value(SecretId=arn, SecretString=token)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code == "ResourceNotFoundException":
            # First-run: secret container exists in IaC but has never been
            # populated. CreateSecret would conflict with CDK's ownership;
            # we still want this UX-rotation to "just work" though.
            client.create_secret(
                Name=_resource_name_from_arn(arn),
                SecretString=token,
            )
        else:
            raise


def _extract_token(secret_resp: dict[str, Any]) -> str:
    """Pull the raw token out of a Secrets Manager response.

    Supports both ``SecretString`` styles:
    - ``"raw-token-value"``  (what we write)
    - ``'{"token": "raw-token-value"}'``  (defensive — some users JSON-
      encode by reflex when they paste secrets)
    """
    s: str | None = secret_resp.get("SecretString")
    if not s:
        return ""
    s = s.strip()
    if not s:
        return ""
    if s.startswith("{") and s.endswith("}"):
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                for key in ("token", "pat", "value"):
                    if key in parsed and isinstance(parsed[key], str):
                        return parsed[key].strip()
        except json.JSONDecodeError:
            pass
    return s


def _resource_name_from_arn(arn: str) -> str:
    """Extract the secret name from a Secrets Manager ARN.

    ARN form: ``arn:aws:secretsmanager:<region>:<acct>:secret:<name>-<6char>``
    """
    last = arn.rsplit(":", 1)[-1]
    # Trim the trailing "-XXXXXX" random suffix Secrets Manager appends.
    if "-" in last and len(last.split("-")[-1]) == 6:
        last = last.rsplit("-", 1)[0]
    return last.removeprefix("secret:")


# ---------------------------------------------------------------------------
# Backend: local file (dev only — bypassed in deployed envs)
# ---------------------------------------------------------------------------


def _load_local() -> str:
    path = _local_token_path()
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def _save_local(token: str) -> None:
    path = _local_token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    try:
        # Owner read/write only.
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        # File system might not support chmod (e.g. mounted FS) — best
        # effort, the file still contains the secret.
        pass
