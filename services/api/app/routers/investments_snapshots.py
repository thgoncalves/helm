"""Investing Dashboard position snapshots.

Mounts under ``/investments/snapshots``.

Routes:

* ``POST   /``                   Capture today's positions across every
                                 manual investing fund + the aggregated
                                 stocks holdings. UPSERTs on
                                 (snapshot_date, source_kind, source_id)
                                 so re-snapshotting the same day replaces
                                 rather than appending.
* ``GET    /history``            Time series of total CAD plus per-source
                                 breakdown — feeds the dashboard chart.
* ``GET    /{snapshot_date}``    Per-source detail for one specific day.

See ``docs/specs/investing-dashboard-snapshots-v1.md`` for the data
model rationale.
"""

from __future__ import annotations

from datetime import date as date_t
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments.fx import FxRateUnavailable, get_rate as fx_rate
from app.models.investing_snapshots import (
    SnapshotDay,
    SnapshotHistoryItem,
    SnapshotRow,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])


_BASE_CCY = "CAD"
_STOCKS_LABEL = "Stocks"


# ---------------------------------------------------------------------------
# POST /
# ---------------------------------------------------------------------------


@router.post("", response_model=SnapshotDay)
def take_snapshot() -> SnapshotDay:
    """Capture today's positions.

    Composition:

    * One row per active manual investing fund (``manual_accounts.kind
      = 'investing_fund'``) at its current balance, FX-converted to CAD.
    * One aggregate row labelled ``Stocks`` summing all stock holdings
      (from ``stock_transactions``) × latest cached quote (from
      ``stock_quotes``), FX-converted per-ticker to CAD.

    Same-day re-snapshot UPSERTs — the partial unique indexes on
    ``investing_snapshots`` keep at most one row per (date, source_kind,
    source_id), so calling this twice replaces yesterday's-by-mistake
    rows rather than duplicating them.
    """
    today = date_t.today()
    rows: list[SnapshotRow] = []

    rows.extend(_snapshot_manual_funds(today))
    rows.extend(_snapshot_ynab_funds(today))
    stocks_row = _snapshot_stocks_aggregate(today)
    if stocks_row is not None:
        rows.append(stocks_row)

    # Persist. Wrap in implicit single-statement UPSERTs — the Data API
    # doesn't expose multi-statement transactions through the wrapper,
    # but each UPSERT is independent so a partial failure leaves the
    # rest in place; user can retry.
    for row in rows:
        _upsert_snapshot_row(row)

    total = sum((r.cad_amount for r in rows), Decimal(0))
    return SnapshotDay(snapshot_date=today, rows=rows, total_cad=total)


# ---------------------------------------------------------------------------
# GET /history
# ---------------------------------------------------------------------------


@router.get("/history", response_model=list[SnapshotHistoryItem])
def list_history() -> list[SnapshotHistoryItem]:
    """All snapshot dates with per-source CAD breakdown.

    Ordered ASC so the chart can feed the result directly into recharts
    without re-sorting client-side. Returns ``[]`` when no snapshots
    have been taken yet (empty-state on the dashboard).
    """
    rows = db.fetch_all(
        """
        SELECT snapshot_date, label, cad_amount
        FROM investing_snapshots
        ORDER BY snapshot_date ASC, label ASC
        """
    )

    by_date: dict[date_t, dict[str, Decimal]] = {}
    for r in rows:
        day = r["snapshot_date"]
        bucket = by_date.setdefault(day, {})
        # If a label somehow appears twice for the same day (it
        # shouldn't, given the partial unique indexes), the latest one
        # wins — matches UPSERT semantics.
        bucket[r["label"]] = Decimal(r["cad_amount"])

    return [
        SnapshotHistoryItem(
            snapshot_date=day,
            total_cad=sum(by_source.values(), Decimal(0)),
            by_source=by_source,
        )
        for day, by_source in sorted(by_date.items())
    ]


# ---------------------------------------------------------------------------
# GET /{snapshot_date}
# ---------------------------------------------------------------------------


@router.get("/{snapshot_date}", response_model=SnapshotDay)
def get_snapshot(snapshot_date: date_t) -> SnapshotDay:
    """Per-source breakdown for one specific day."""
    rows = db.fetch_all(
        """
        SELECT snapshot_date,
               source_kind,
               source_id,
               label,
               native_currency,
               native_amount,
               cad_amount,
               fx_rate,
               created_at
        FROM investing_snapshots
        WHERE snapshot_date = :on
        ORDER BY source_kind, label
        """,
        {"on": snapshot_date},
    )
    if not rows:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "SNAPSHOT_NOT_FOUND",
                "snapshot_date": snapshot_date.isoformat(),
            },
        )

    snapshot_rows = [SnapshotRow(**r) for r in rows]
    total = sum((r.cad_amount for r in snapshot_rows), Decimal(0))
    return SnapshotDay(
        snapshot_date=snapshot_date, rows=snapshot_rows, total_cad=total
    )


# ---------------------------------------------------------------------------
# Composition helpers
# ---------------------------------------------------------------------------


def _snapshot_manual_funds(on: date_t) -> list[SnapshotRow]:
    """One row per active manual investing fund.

    The user types these balances by hand (XP, Santander) — the
    snapshot captures whatever's in ``manual_accounts.balance`` at the
    moment of the call. Inactive (soft-deleted) accounts are skipped;
    zero balances are still recorded so the chart shows a step down
    when a fund is drained.
    """
    funds = db.fetch_all(
        """
        SELECT id, name, currency, balance
        FROM manual_accounts
        WHERE kind = 'investing_fund' AND is_active = TRUE
        ORDER BY name
        """
    )

    out: list[SnapshotRow] = []
    for f in funds:
        native_ccy = (f.get("currency") or _BASE_CCY).upper()
        native_amount = Decimal(f["balance"]) if f["balance"] is not None else Decimal(0)
        rate, cad_amount = _convert(native_amount, native_ccy)
        out.append(
            SnapshotRow(
                snapshot_date=on,
                source_kind="manual_fund",
                source_id=str(f["id"]),
                label=f["name"],
                native_currency=native_ccy,
                native_amount=native_amount,
                cad_amount=cad_amount,
                fx_rate=rate,
            )
        )
    return out


def _snapshot_ynab_funds(on: date_t) -> list[SnapshotRow]:
    """One row per YNAB account the user has tagged investing_fund.

    Balance comes from YNAB's last-synced ``cleared_balance``
    (milliunits → decimal). YNAB balances are denominated in the
    account's budget currency; for our user base that's CAD for every
    investing-tagged account, so we assume CAD (matches what
    ``/accounts`` does) and skip the FX cache. If a non-CAD YNAB
    budget ever shows up, ``_convert`` will route it through the BoC
    cache like manual funds.

    Closed/deleted YNAB accounts are excluded — they appear on the
    Accounts page but shouldn't drift into the snapshot total.
    """
    funds = db.fetch_all(
        """
        SELECT id, name, balance
        FROM ynab_accounts
        WHERE helm_kind = 'investing_fund'
          AND closed = FALSE
          AND deleted = FALSE
        ORDER BY name
        """
    )

    out: list[SnapshotRow] = []
    for f in funds:
        # YNAB stores all monetary fields in milliunits (CAD 12.34 → 12340).
        # We read ``balance`` (not ``cleared_balance``) to match what the
        # /accounts and Funds-vs-Stocks endpoints surface — otherwise the
        # snapshot undercounts whenever a transaction is still pending.
        milliunits = Decimal(int(f.get("balance") or 0))
        native_amount = (milliunits / Decimal(1000)).quantize(Decimal("0.01"))
        # YNAB-tagged investing accounts are CAD-denominated in practice;
        # _convert short-circuits to rate=1 when native is CAD.
        rate, cad_amount = _convert(native_amount, _BASE_CCY)
        out.append(
            SnapshotRow(
                snapshot_date=on,
                source_kind="ynab_fund",
                source_id=str(f["id"]),
                label=f["name"],
                native_currency=_BASE_CCY,
                native_amount=native_amount,
                cad_amount=cad_amount,
                fx_rate=rate,
            )
        )
    return out


def _snapshot_stocks_aggregate(on: date_t) -> SnapshotRow | None:
    """Aggregate row for all stock holdings (sum × quote, FX → CAD).

    Returns ``None`` when there are no stock transactions at all — no
    sense recording a zero stocks row in that case (drowns out actual
    fund movements on the chart).
    """
    positions = db.fetch_all(
        """
        SELECT t.ticker,
               SUM(CASE WHEN t.transaction_type = 'buy'  THEN t.quantity
                        WHEN t.transaction_type = 'sell' THEN -t.quantity
                        ELSE 0 END) AS shares,
               q.last_price,
               q.currency AS quote_currency
        FROM stock_transactions t
        LEFT JOIN stock_quotes q ON q.ticker = t.ticker
        GROUP BY t.ticker, q.last_price, q.currency
        HAVING SUM(CASE WHEN t.transaction_type = 'buy'  THEN t.quantity
                        WHEN t.transaction_type = 'sell' THEN -t.quantity
                        ELSE 0 END) > 0
        """
    )
    if not positions:
        return None

    total_cad = Decimal(0)
    for p in positions:
        if p.get("last_price") is None:
            # No cached quote → can't value this ticker; skip silently
            # rather than rejecting the whole snapshot.
            continue
        shares = Decimal(p["shares"])
        price = Decimal(p["last_price"])
        native_value = shares * price
        quote_ccy = (p.get("quote_currency") or "USD").upper()
        _, cad_value = _convert(native_value, quote_ccy)
        total_cad += cad_value

    total_cad = total_cad.quantize(Decimal("0.01"))
    return SnapshotRow(
        snapshot_date=on,
        source_kind="stocks",
        source_id=None,
        label=_STOCKS_LABEL,
        native_currency=_BASE_CCY,
        native_amount=total_cad,
        cad_amount=total_cad,
        fx_rate=Decimal("1"),
    )


def _convert(amount: Decimal, currency: str) -> tuple[Decimal, Decimal]:
    """Return ``(fx_rate, cad_amount)`` rounded to 2dp.

    Same-currency CAD → CAD short-circuits at rate=1. FX miss falls
    back to rate=0 + cad_amount=0; the snapshot still records the
    native amount so the user can re-snapshot once BoC publishes.
    """
    if currency == _BASE_CCY:
        return Decimal("1"), amount.quantize(Decimal("0.01"))
    try:
        rate = fx_rate(currency, _BASE_CCY).rate
    except FxRateUnavailable:
        return Decimal("0"), Decimal("0")
    return rate, (amount * rate).quantize(Decimal("0.01"))


def _upsert_snapshot_row(row: SnapshotRow) -> None:
    """UPSERT one snapshot row keyed on (date, source_kind, source_id).

    Two different ON CONFLICT targets are needed because the unique
    indexes are partial (one for manual_fund, one for stocks). The
    column list to set on conflict is identical.
    """
    common_params: dict[str, Any] = {
        "snapshot_date": row.snapshot_date,
        "source_kind": row.source_kind,
        "source_id": row.source_id,
        "label": row.label,
        "native_currency": row.native_currency,
        "native_amount": row.native_amount,
        "cad_amount": row.cad_amount,
        "fx_rate": row.fx_rate,
    }
    # Each source_kind has its own partial unique index, so ON CONFLICT
    # has to name the matching predicate explicitly. The SET list is
    # identical across all three.
    _UPSERT_SET = """
        label = EXCLUDED.label,
        native_currency = EXCLUDED.native_currency,
        native_amount = EXCLUDED.native_amount,
        cad_amount = EXCLUDED.cad_amount,
        fx_rate = EXCLUDED.fx_rate
    """
    insert = """
        INSERT INTO investing_snapshots
            (snapshot_date, source_kind, source_id, label,
             native_currency, native_amount, cad_amount, fx_rate)
        VALUES
            (:snapshot_date, :source_kind, :source_id, :label,
             :native_currency, :native_amount, :cad_amount, :fx_rate)
    """
    if row.source_kind == "stocks":
        conflict = (
            "ON CONFLICT (snapshot_date) WHERE source_kind = 'stocks' "
            "DO UPDATE SET"
        )
    elif row.source_kind == "ynab_fund":
        conflict = (
            "ON CONFLICT (snapshot_date, source_id) "
            "WHERE source_kind = 'ynab_fund' DO UPDATE SET"
        )
    else:  # manual_fund
        conflict = (
            "ON CONFLICT (snapshot_date, source_id) "
            "WHERE source_kind = 'manual_fund' DO UPDATE SET"
        )
    db.execute(f"{insert} {conflict} {_UPSERT_SET}", common_params)
