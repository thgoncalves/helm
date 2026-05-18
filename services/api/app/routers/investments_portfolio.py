"""FastAPI router for ``/investments/portfolio``.

Single-shot endpoint that returns everything the Overview page needs:
totals, per-account-kind rollup, allocation vs target drift, and the
full holdings list. Brazilian (BRL) holdings are converted to CAD via
the FX cache; the rate used is included in the response so the UI can
show which day's rate fed the rollup.

The ``/fx/refresh`` endpoint lives here too — it's a tiny one-liner and
shares the same module's mental model.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments.fx import (
    FxRate,
    FxRateUnavailable,
    get_rate,
    refresh_rate,
)
from app.models.investments import (
    FxRateRead,
    PortfolioAllocationRow,
    PortfolioByKind,
    PortfolioFxUsed,
    PortfolioHolding,
    PortfolioResponse,
    PortfolioTotals,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

_TWO_DP = Decimal("0.01")
_PCT_DP = Decimal("0.01")
_BASE_CURRENCY = "CAD"


@router.get("/", response_model=PortfolioResponse)
def get_portfolio() -> PortfolioResponse:
    accounts: list[dict[str, Any]] = db.fetch_all(
        "SELECT id, name, kind, currency FROM investment_accounts "
        "WHERE is_active = TRUE"
    )
    if not accounts:
        return _empty_response()
    account_by_id = {row["id"]: row for row in accounts}

    holdings: list[dict[str, Any]] = db.fetch_all(
        """
        SELECT h.id, h.account_id, h.ticker, h.asset_class, h.shares,
               h.avg_cost, h.current_price, h.currency, h.as_of
        FROM investment_holdings h
        JOIN investment_accounts a ON a.id = h.account_id
        WHERE a.is_active = TRUE
        ORDER BY a.name, h.ticker
        """
    )
    if not holdings:
        return _empty_response()

    # ---- FX prep: pull every distinct non-CAD currency once. ---------------
    fx_used: dict[str, FxRate] = {}
    for h in holdings:
        ccy = str(h["currency"])
        if ccy == _BASE_CURRENCY or ccy in fx_used:
            continue
        try:
            fx_used[ccy] = get_rate(ccy, _BASE_CURRENCY)
        except FxRateUnavailable as e:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "FX_UNAVAILABLE",
                    "message": str(e),
                    "currency": ccy,
                },
            ) from e

    # ---- Walk holdings, build rows + roll up totals. -----------------------
    portfolio_holdings: list[PortfolioHolding] = []
    market_value_cad_total = Decimal("0")
    cost_basis_cad_total = Decimal("0")
    by_kind: dict[str, Decimal] = {}
    by_class: dict[str, Decimal] = {}

    for h in holdings:
        account = account_by_id[h["account_id"]]
        currency = str(h["currency"])
        shares = _dec(h["shares"])
        avg_cost = _dec(h["avg_cost"])
        current_price = _dec(h["current_price"])

        native_mv = (shares * current_price).quantize(_TWO_DP)
        native_cost = (shares * avg_cost).quantize(_TWO_DP)
        if currency == _BASE_CURRENCY:
            cad_mv = native_mv
            cad_cost = native_cost
        else:
            fx = fx_used[currency].rate
            cad_mv = (native_mv * fx).quantize(_TWO_DP)
            cad_cost = (native_cost * fx).quantize(_TWO_DP)

        unrealized = (cad_mv - cad_cost).quantize(_TWO_DP)
        unrealized_pct = (
            (unrealized / cad_cost * Decimal(100)).quantize(_PCT_DP)
            if cad_cost > 0
            else None
        )

        portfolio_holdings.append(
            PortfolioHolding(
                id=h["id"],
                account_id=h["account_id"],
                account_name=str(account["name"]),
                account_kind=str(account["kind"]),  # type: ignore[arg-type]
                ticker=str(h["ticker"]),
                asset_class=h["asset_class"],
                shares=shares,
                avg_cost=avg_cost,
                current_price=current_price,
                currency=currency,
                market_value_native=native_mv,
                market_value_cad=cad_mv,
                unrealized=unrealized,
                unrealized_pct=unrealized_pct,
                as_of=h["as_of"],
            )
        )

        market_value_cad_total += cad_mv
        cost_basis_cad_total += cad_cost
        by_kind[str(account["kind"])] = (
            by_kind.get(str(account["kind"]), Decimal("0")) + cad_mv
        )
        by_class[str(h["asset_class"])] = (
            by_class.get(str(h["asset_class"]), Decimal("0")) + cad_mv
        )

    # ---- Targets & allocation rows. ---------------------------------------
    target_rows: list[dict[str, Any]] = db.fetch_all(
        "SELECT asset_class, target_pct FROM target_allocations"
    )
    target_by_class = {
        str(r["asset_class"]): _dec(r["target_pct"]) for r in target_rows
    }

    allocation: list[PortfolioAllocationRow] = []
    classes_seen = set(by_class) | set(target_by_class)
    for cls in sorted(classes_seen):
        mv = by_class.get(cls, Decimal("0"))
        actual_pct = (
            (mv / market_value_cad_total * Decimal(100)).quantize(_PCT_DP)
            if market_value_cad_total > 0
            else Decimal("0")
        )
        target_pct = target_by_class.get(cls)
        drift_pct = (
            (actual_pct - target_pct).quantize(_PCT_DP)
            if target_pct is not None
            else None
        )
        allocation.append(
            PortfolioAllocationRow(
                asset_class=cls,  # type: ignore[arg-type]
                market_value=mv.quantize(_TWO_DP),
                actual_pct=actual_pct,
                target_pct=target_pct,
                drift_pct=drift_pct,
            )
        )

    # ---- By-kind rollup with share %. -------------------------------------
    by_kind_rows: list[PortfolioByKind] = []
    for kind in ("itrade", "rrsp", "tfsa", "brazil", "corp"):
        mv = by_kind.get(kind, Decimal("0"))
        share_pct = (
            (mv / market_value_cad_total * Decimal(100)).quantize(_PCT_DP)
            if market_value_cad_total > 0
            else None
        )
        # Always emit a row per kind for stable charting on the frontend
        # (zero-value rows just render as empty slices).
        by_kind_rows.append(
            PortfolioByKind(
                kind=kind,  # type: ignore[arg-type]
                market_value=mv.quantize(_TWO_DP),
                share_pct=share_pct,
            )
        )

    unrealized = (market_value_cad_total - cost_basis_cad_total).quantize(_TWO_DP)
    unrealized_pct = (
        (unrealized / cost_basis_cad_total * Decimal(100)).quantize(_PCT_DP)
        if cost_basis_cad_total > 0
        else None
    )

    return PortfolioResponse(
        as_of=date.today(),
        currency=_BASE_CURRENCY,
        totals=PortfolioTotals(
            market_value=market_value_cad_total.quantize(_TWO_DP),
            cost_basis=cost_basis_cad_total.quantize(_TWO_DP),
            unrealized=unrealized,
            unrealized_pct=unrealized_pct,
        ),
        by_account_kind=by_kind_rows,
        allocation=allocation,
        holdings=portfolio_holdings,
        fx_rates_used=[
            PortfolioFxUsed(
                pair=f"{fx.from_currency}_{fx.to_currency}",
                rate=fx.rate,
                rate_date=fx.rate_date,
            )
            for fx in fx_used.values()
        ],
    )


# ---------------------------------------------------------------------------
# FX manual refresh (still under the portfolio router for cohesion).
# ---------------------------------------------------------------------------


@router.post("/fx/refresh", response_model=FxRateRead)
def fx_refresh(from_ccy: str = "BRL", to_ccy: str = "CAD") -> dict[str, Any]:
    rate = refresh_rate(from_ccy.upper(), to_ccy.upper())
    return {
        "from_currency": rate.from_currency,
        "to_currency": rate.to_currency,
        "rate_date": rate.rate_date,
        "rate": rate.rate,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _dec(v: Any) -> Decimal:
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def _empty_response() -> PortfolioResponse:
    """Return a well-formed empty payload when there are no holdings."""
    return PortfolioResponse(
        as_of=date.today(),
        currency=_BASE_CURRENCY,
        totals=PortfolioTotals(
            market_value=Decimal("0"),
            cost_basis=Decimal("0"),
            unrealized=Decimal("0"),
            unrealized_pct=None,
        ),
        by_account_kind=[
            PortfolioByKind(
                kind=k,  # type: ignore[arg-type]
                market_value=Decimal("0"),
                share_pct=None,
            )
            for k in ("itrade", "rrsp", "tfsa", "brazil", "corp")
        ],
        allocation=[],
        holdings=[],
        fx_rates_used=[],
    )
