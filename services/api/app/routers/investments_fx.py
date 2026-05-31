"""Investing FX surface — mounts under ``/investments/fx``.

Routes:

* ``GET /cad-brl`` — the CAD/BRL rate (BRL per 1 CAD) with its direction
  versus the previous cached trading day. The dashboard shows this beside
  the portfolio so the user can eyeball whether CAD is strengthening.

The underlying ``fx_rates`` cache stores BoC's BRL→CAD series with one row
per ``rate_date``, so CAD/BRL is just its inverse and "direction" is the
change between the two most recent cached dates.
"""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments import fx
from app.models.fx import FxQuote

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

_FOUR_DP = Decimal("0.0001")
_TWO_DP = Decimal("0.01")


@router.get("/cad-brl", response_model=FxQuote)
def cad_brl() -> FxQuote:
    """CAD/BRL (BRL per 1 CAD) with up/down vs. the previous cached rate."""
    # Best-effort: make sure today's BRL→CAD rate is cached. Swallow
    # failures so a BoC outage still serves the last cached rate below.
    try:
        fx.get_rate("BRL", "CAD")
    except fx.FxRateUnavailable:
        pass

    rows = db.fetch_all(
        """
        SELECT rate, rate_date
        FROM fx_rates
        WHERE from_currency = 'BRL' AND to_currency = 'CAD'
        ORDER BY rate_date DESC
        LIMIT 2
        """
    )
    if not rows:
        raise HTTPException(
            status_code=503,
            detail="No CAD/BRL rate available yet.",
        )

    # The cache stores BRL→CAD; CAD/BRL is its inverse.
    latest_brlcad = Decimal(rows[0]["rate"])
    rate = (Decimal(1) / latest_brlcad).quantize(_FOUR_DP)

    prev_rate = None
    change = None
    change_pct = None
    direction = None
    if len(rows) > 1 and Decimal(rows[1]["rate"]) != 0:
        prev_rate = (Decimal(1) / Decimal(rows[1]["rate"])).quantize(_FOUR_DP)
        change = (rate - prev_rate).quantize(_FOUR_DP)
        if prev_rate != 0:
            change_pct = (change / prev_rate * Decimal(100)).quantize(_TWO_DP)
        direction = "up" if change > 0 else "down" if change < 0 else "flat"

    return FxQuote(
        pair="CAD/BRL",
        rate=rate,
        prev_rate=prev_rate,
        change=change,
        change_pct=change_pct,
        direction=direction,
        as_of=rows[0]["rate_date"],
    )
