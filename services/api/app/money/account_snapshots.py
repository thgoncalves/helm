"""Per-account daily balance snapshot capture.

Writes one row per (``snapshot_date``, ``account_id``) to
``account_balance_snapshots``. Repeated writes on the same day upsert in
place — today's row always reflects the latest write that triggered it,
which makes the series effectively daily.

Called from the same balance-change paths as the net-worth snapshot
writer (:func:`app.money.snapshots.record_snapshot`):

* ``app.ynab.sync.refresh`` — after each YNAB pull.
* ``app.routers.accounts_manual`` — POST / PATCH / DELETE.
* ``app.routers.accounts.update_tags`` — kind / owner changes.
* ``app.routers.accounts.list_accounts`` — so simply viewing the page
  seeds today's point.

Failures must never block the originating operation — we swallow
exceptions and log, exactly like the net-worth writer.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from app import db

logger = logging.getLogger(__name__)

_TWO_DP = Decimal("0.01")


def record_account_snapshots() -> None:
    """Upsert today's balance for every active account.

    Idempotent on ``(snapshot_date, account_id)``. Safe to call from any
    write path; any failure is logged and swallowed so it can never break
    the caller.
    """
    try:
        _do_record()
    except Exception:  # noqa: BLE001 — never raise to the caller.
        logger.exception("account balance snapshot capture failed; ignoring")


def _do_record() -> None:
    # Imported lazily: the accounts router imports the net-worth snapshot
    # writer, so importing the loaders at module scope would create a cycle.
    from app.routers.accounts import _load_manual_rows, _load_ynab_rows

    now = datetime.now(timezone.utc)
    today = now.date()

    rows = [*_load_ynab_rows(), *_load_manual_rows()]
    for acc in rows:
        db.execute(
            """
            INSERT INTO account_balance_snapshots (
                snapshot_date, account_id, source, currency,
                native_amount, cad_amount, created_at
            )
            VALUES (
                :snapshot_date, :account_id, :source, :currency,
                :native_amount, :cad_amount, :created_at
            )
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                source        = EXCLUDED.source,
                currency      = EXCLUDED.currency,
                native_amount = EXCLUDED.native_amount,
                cad_amount    = EXCLUDED.cad_amount,
                created_at    = EXCLUDED.created_at
            """,
            {
                "snapshot_date": today,
                "account_id": acc.id,
                "source": acc.source,
                "currency": acc.currency,
                "native_amount": acc.balance.quantize(_TWO_DP),
                "cad_amount": (
                    acc.balance_cad.quantize(_TWO_DP)
                    if acc.balance_cad is not None
                    else None
                ),
                "created_at": now,
            },
        )


def fetch_history(account_id: str, days: int) -> list[dict[str, object]]:
    """Return the last ``days`` snapshots for one account, oldest first.

    ``account_id`` is the namespaced unified id (``"ynab:<id>"`` /
    ``"manual:<id>"``).
    """
    start = date.today() - timedelta(days=days - 1)
    rows = db.fetch_all(
        """
        SELECT snapshot_date, native_amount, cad_amount
        FROM account_balance_snapshots
        WHERE account_id = :account_id AND snapshot_date >= :start
        ORDER BY snapshot_date DESC
        """,
        {"account_id": account_id, "start": start},
    )
    # Sort oldest-first in Python so the order is correct even where the
    # SQL ORDER BY isn't honoured (the in-memory test DB ignores it).
    return sorted(rows, key=lambda r: r["snapshot_date"])
