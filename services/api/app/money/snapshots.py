"""Net-worth snapshot capture.

Writes one row per calendar month to ``net_worth_snapshots``. Repeated
writes within a month upsert in place — the snapshot for the current
month always reflects the latest write that triggered it.

Called from the account write paths:

* ``app.ynab.sync.refresh`` — after each YNAB pull.
* ``app.routers.accounts_manual`` — POST / PATCH / DELETE.
* ``app.routers.investments_accounts`` — POST / PATCH / DELETE.
* ``app.routers.accounts.update_tags`` — kind / owner changes affect
  the kind + owner breakdown.

Failures in the snapshot writer must not block the originating
operation — we swallow exceptions and log so a transient FX outage or
DB hiccup doesn't roll back the user's account edit.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal

from app import db
from app.money.balances import compute_balances

logger = logging.getLogger(__name__)

_TWO_DP = Decimal("0.01")


def record_snapshot() -> None:
    """Capture current balances into the snapshot table.

    Idempotent on ``snapshot_month`` — the current month's row is
    overwritten on every call. Safe to call from any write path; any
    failure is logged and swallowed so it can never break the caller.
    """
    try:
        _do_record()
    except Exception:  # noqa: BLE001 — never raise to the caller.
        logger.exception("net-worth snapshot capture failed; ignoring")


def _do_record() -> None:
    now = datetime.now(timezone.utc)
    month_first = now.date().replace(day=1)

    balances = compute_balances()

    db.execute(
        """
        INSERT INTO net_worth_snapshots (
            snapshot_month,
            assets_cad, liabilities_cad,
            checking_cad, savings_cad, investing_cad, lending_cad,
            personal_cad, business_cad,
            taken_at
        )
        VALUES (
            :snapshot_month,
            :assets_cad, :liabilities_cad,
            :checking_cad, :savings_cad, :investing_cad, :lending_cad,
            :personal_cad, :business_cad,
            :taken_at
        )
        ON CONFLICT (snapshot_month) DO UPDATE SET
            assets_cad      = EXCLUDED.assets_cad,
            liabilities_cad = EXCLUDED.liabilities_cad,
            checking_cad    = EXCLUDED.checking_cad,
            savings_cad     = EXCLUDED.savings_cad,
            investing_cad   = EXCLUDED.investing_cad,
            lending_cad     = EXCLUDED.lending_cad,
            personal_cad    = EXCLUDED.personal_cad,
            business_cad    = EXCLUDED.business_cad,
            taken_at        = EXCLUDED.taken_at
        """,
        {
            "snapshot_month": month_first,
            "assets_cad": balances.assets_cad.quantize(_TWO_DP),
            "liabilities_cad": balances.liabilities_cad.quantize(_TWO_DP),
            "checking_cad": balances.by_kind.get(
                "checking", Decimal("0")
            ).quantize(_TWO_DP),
            "savings_cad": balances.by_kind.get(
                "savings", Decimal("0")
            ).quantize(_TWO_DP),
            "investing_cad": balances.investing_cad.quantize(_TWO_DP),
            "lending_cad": balances.lending_cad.quantize(_TWO_DP),
            "personal_cad": (
                balances.personal_assets - balances.personal_liabilities
            ).quantize(_TWO_DP),
            "business_cad": (
                balances.business_assets - balances.business_liabilities
            ).quantize(_TWO_DP),
            "taken_at": now,
        },
    )


def fetch_trend(months: int) -> list[dict[str, object]]:
    """Return the most recent ``months`` snapshots, oldest first."""
    rows = db.fetch_all(
        """
        SELECT
            snapshot_month,
            assets_cad,
            liabilities_cad,
            checking_cad,
            savings_cad,
            investing_cad,
            lending_cad,
            personal_cad,
            business_cad
        FROM net_worth_snapshots
        ORDER BY snapshot_month DESC
        LIMIT :limit
        """,
        {"limit": months},
    )
    # The query returned newest first to keep the LIMIT honest; the
    # frontend wants oldest-first for the line chart.
    return list(reversed(rows))


def fetch_snapshot_for_month(month: date) -> dict[str, object] | None:
    """Return the snapshot row for a given calendar month, if any."""
    return db.fetch_one(
        "SELECT * FROM net_worth_snapshots WHERE snapshot_month = :m",
        {"m": month.replace(day=1)},
    )
