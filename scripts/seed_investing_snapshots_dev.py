# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3>=1.35",
# ]
# ///
"""Backfill ~30 days of mock investing snapshots on the dev DB.

Reads today's live positions (manual funds, YNAB funds, computed stocks
aggregate) and walks BACKWARDS day by day, applying a small random
walk to each source's CAD value. Inserts one row per source per day
into ``investing_snapshots`` using the same partial-unique-index
UPSERTs the router uses.

Idempotent — re-running replaces the rows it just wrote.

Run with:
    AWS_PROFILE=helm AWS_REGION=ca-central-1 \\
    HELM_DATABASE_RESOURCE_ARN=... \\
    HELM_DATABASE_SECRET_ARN=... \\
    uv run scripts/seed_investing_snapshots_dev.py
"""

from __future__ import annotations

import os
import random
import sys
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import boto3

DAYS_BACK = 30
# Daily multiplicative shock per source — small and slightly upward
# biased so the chart looks like a real-ish growing portfolio.
DAILY_SIGMA = 0.008  # ~0.8% daily volatility
DAILY_DRIFT = 0.0008  # tiny upward drift


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"error: env var {name} is required")
    return val


def fetch_today_sources(
    client: Any, *, resource_arn: str, secret_arn: str, database: str
) -> list[dict[str, Any]]:
    """Read today's snapshot as the anchor for the backfill.

    Anchoring on ``investing_snapshots`` (rather than raw live tables)
    is critical because it carries the *CAD* value with the correct FX
    already applied. Walking backwards from native BRL would produce a
    chart that lies — pretending Santander was CAD 1.4M when it's
    really CAD 376k.

    Requires a snapshot to already exist for today (the user's "Snapshot
    today" click). Errors out if none — refusing to invent a baseline.
    """
    rows = _rows_to_dicts(
        client.execute_statement(
            resourceArn=resource_arn,
            secretArn=secret_arn,
            database=database,
            sql=(
                "SELECT source_kind, source_id, label, native_currency, "
                "       native_amount, cad_amount, fx_rate "
                "FROM investing_snapshots "
                "WHERE snapshot_date = ("
                "    SELECT MAX(snapshot_date) FROM investing_snapshots"
                ") "
                "ORDER BY source_kind, label"
            ),
            includeResultMetadata=True,
        )
    )
    if not rows:
        sys.exit(
            "error: no snapshot rows on dev — click 'Snapshot today' in the "
            "UI first so the seed has an anchor to walk backwards from."
        )
    return [
        {
            "source_kind": r["source_kind"],
            "source_id": r["source_id"],
            "label": r["label"],
            "native_currency": r["native_currency"],
            "native_amount": Decimal(r["native_amount"]),
            "cad_amount": Decimal(r["cad_amount"]),
            "fx_rate": Decimal(r["fx_rate"]),
        }
        for r in rows
    ]


_UPSERT_SET = (
    "label = EXCLUDED.label, "
    "native_currency = EXCLUDED.native_currency, "
    "native_amount = EXCLUDED.native_amount, "
    "cad_amount = EXCLUDED.cad_amount, "
    "fx_rate = EXCLUDED.fx_rate"
)


def _conflict_clause(source_kind: str) -> str:
    if source_kind == "stocks":
        return (
            "ON CONFLICT (snapshot_date) WHERE source_kind = 'stocks' "
            "DO UPDATE SET " + _UPSERT_SET
        )
    if source_kind == "ynab_fund":
        return (
            "ON CONFLICT (snapshot_date, source_id) "
            "WHERE source_kind = 'ynab_fund' DO UPDATE SET " + _UPSERT_SET
        )
    return (
        "ON CONFLICT (snapshot_date, source_id) "
        "WHERE source_kind = 'manual_fund' DO UPDATE SET " + _UPSERT_SET
    )


def upsert_row(
    client: Any,
    *,
    resource_arn: str,
    secret_arn: str,
    database: str,
    on: date,
    source: dict[str, Any],
    native_amount: Decimal,
    fx_rate: Decimal,
    cad_amount: Decimal,
) -> None:
    sql = (
        "INSERT INTO investing_snapshots "
        "(snapshot_date, source_kind, source_id, label, "
        " native_currency, native_amount, cad_amount, fx_rate) "
        "VALUES (:snapshot_date, :source_kind, :source_id, :label, "
        " :native_currency, :native_amount, :cad_amount, :fx_rate) "
        + _conflict_clause(source["source_kind"])
    )
    params: list[dict[str, Any]] = [
        _p_date("snapshot_date", on),
        _p_str("source_kind", source["source_kind"]),
        _p_str_or_null("source_id", source["source_id"]),
        _p_str("label", source["label"]),
        _p_str("native_currency", source["native_currency"]),
        _p_decimal("native_amount", native_amount),
        _p_decimal("cad_amount", cad_amount),
        _p_decimal("fx_rate", fx_rate),
    ]
    client.execute_statement(
        resourceArn=resource_arn,
        secretArn=secret_arn,
        database=database,
        sql=sql,
        parameters=params,
    )


# ---------------------------------------------------------------------------
# Data API helpers (mini — we don't import app.db since this is a script).
# ---------------------------------------------------------------------------


def _p_date(name: str, v: date) -> dict[str, Any]:
    return {
        "name": name,
        "value": {"stringValue": v.isoformat()},
        "typeHint": "DATE",
    }


def _p_str(name: str, v: str) -> dict[str, Any]:
    return {"name": name, "value": {"stringValue": v}}


def _p_str_or_null(name: str, v: str | None) -> dict[str, Any]:
    if v is None:
        return {"name": name, "value": {"isNull": True}}
    return _p_str(name, v)


def _p_decimal(name: str, v: Decimal) -> dict[str, Any]:
    return {
        "name": name,
        "value": {"stringValue": str(v)},
        "typeHint": "DECIMAL",
    }


def _rows_to_dicts(response: dict[str, Any]) -> list[dict[str, Any]]:
    cols = [(c["name"], c.get("typeName")) for c in response.get("columnMetadata", [])]
    out: list[dict[str, Any]] = []
    for record in response.get("records", []):
        row: dict[str, Any] = {}
        for (name, type_name), field in zip(cols, record):
            if field.get("isNull"):
                row[name] = None
            elif "longValue" in field:
                row[name] = field["longValue"]
            elif "doubleValue" in field:
                row[name] = field["doubleValue"]
            elif "booleanValue" in field:
                row[name] = field["booleanValue"]
            elif "stringValue" in field:
                s = field["stringValue"]
                row[name] = Decimal(s) if type_name == "numeric" else s
            else:
                row[name] = None
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    resource_arn = require_env("HELM_DATABASE_RESOURCE_ARN")
    secret_arn = require_env("HELM_DATABASE_SECRET_ARN")
    database = os.environ.get("HELM_DATABASE_NAME", "helm")

    client = boto3.client("rds-data")

    print("→ reading today's live sources")
    sources = fetch_today_sources(
        client,
        resource_arn=resource_arn,
        secret_arn=secret_arn,
        database=database,
    )
    if not sources:
        sys.exit("error: no investing sources found on dev")
    print(f"  found {len(sources)} sources to backfill")

    # Deterministic shocks so re-runs produce the same series.
    rng = random.Random(42)

    today = date.today()
    # Per-source running "anchor" — we walk BACKWARDS, so start each source
    # at its current CAD value and rewind. Walking on CAD (not native)
    # keeps the chart honest; native amounts are derived by /fx_rate.
    anchors: dict[tuple[str, str | None], Decimal] = {
        (s["source_kind"], s["source_id"]): s["cad_amount"] for s in sources
    }

    written = 0
    for offset in range(1, DAYS_BACK + 1):
        on = today - timedelta(days=offset)
        for source in sources:
            key = (source["source_kind"], source["source_id"])
            # Walk: x_{t-1} = x_t / (1 + drift + sigma*z) — invert the
            # forward update so the series ends at today's known value.
            shock = Decimal(str(1 + DAILY_DRIFT + DAILY_SIGMA * rng.gauss(0, 1)))
            if shock <= 0:
                shock = Decimal("0.99")
            prev_cad = anchors[key] / shock
            prev_cad = prev_cad.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            anchors[key] = prev_cad

            # Derive native_amount by dividing back by today's fx_rate
            # (a small lie — real FX moved too — but small enough not to
            # matter for visual chart context).
            fx_rate = source["fx_rate"] or Decimal("1")
            native_amount = (
                prev_cad / fx_rate if fx_rate != 0 else prev_cad
            ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

            upsert_row(
                client,
                resource_arn=resource_arn,
                secret_arn=secret_arn,
                database=database,
                on=on,
                source=source,
                native_amount=native_amount,
                fx_rate=fx_rate,
                cad_amount=prev_cad,
            )
            written += 1

    print(f"✓ wrote {written} mock snapshot rows across {DAYS_BACK} days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
