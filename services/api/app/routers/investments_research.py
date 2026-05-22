"""Stocks Research V1 — curated-universe browsing surface.

Mounts under ``/investments/research``.

Routes:

* ``GET    /``                   List all research tickers with cached
                                 quote (LEFT JOIN) and the user's
                                 aggregated position, FX-converted to
                                 CAD when applicable.
* ``POST   /refresh/{ticker}``   Force a Twelve Data quote refresh for
                                 one ticker. 404 if the ticker isn't in
                                 ``research_tickers``.

Prices are reused from ``stock_quotes`` — the Research view tolerates
older data than the detail view (24h vs. 15min) but uses the same
cache. Positions are aggregated from ``stock_transactions`` across
both polymorphic sources (manual + ynab).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import get_current_user
from app.investments.fx import FxRateUnavailable, get_rate as fx_rate
from app.investments.stocks_quotes import (
    QuoteApiKeyMissing,
    QuoteRateLimited,
    QuoteUpstreamError,
    TickerNotFound,
    get_quote,
)
from app.models.research import ResearchRow

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])


_BASE_CCY = "CAD"


def _quote_http(exc: QuoteUpstreamError) -> HTTPException:
    """Map Twelve Data exceptions to API Gateway-friendly HTTP errors."""
    if isinstance(exc, TickerNotFound):
        return HTTPException(
            status_code=404,
            detail={"code": "TICKER_NOT_FOUND", "ticker": exc.ticker},
        )
    if isinstance(exc, QuoteRateLimited):
        return HTTPException(
            status_code=503,
            detail={
                "code": "QUOTE_RATE_LIMITED",
                "message": "Price provider is rate-limiting us.",
            },
        )
    if isinstance(exc, QuoteApiKeyMissing):
        return HTTPException(
            status_code=503,
            detail={"code": "QUOTE_API_KEY_MISSING", "message": str(exc)},
        )
    return HTTPException(
        status_code=502,
        detail={"code": "QUOTE_UPSTREAM", "message": str(exc)},
    )


def _to_cad(amount: Decimal | None, currency: str | None) -> Decimal | None:
    """CAD conversion that returns ``None`` on FX miss (vs. silently
    short-circuiting). Same shape as the Stocks landing's strict
    converter."""
    if amount is None or amount == Decimal(0):
        return amount
    if not currency or currency.upper() == _BASE_CCY:
        return amount
    try:
        rate = fx_rate(currency.upper(), _BASE_CCY).rate
    except FxRateUnavailable:
        return None
    return (amount * rate).quantize(Decimal("0.01"))


# ---------------------------------------------------------------------------
# GET /
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ResearchRow])
def list_research() -> list[ResearchRow]:
    """Return one row per curated ticker, in seeded ``sort_order``.

    Joins:

    * ``research_tickers`` (the curated universe — seeded once)
    * ``stock_quotes`` (LEFT JOIN — null fields when no quote cached yet)
    * aggregated ``stock_transactions`` (the user's position, summed
      across polymorphic sources)

    The user's position is the running net of buys minus sells across
    every (source, account) row in ``stock_transactions``. V1 only
    writes buy rows, so this is just SUM(quantity) and SUM(quantity *
    unit_price + fees) for the cost basis (unused on this surface, but
    available for free).
    """
    # 1) Universe + cached quote in one shot.
    rows = db.fetch_all(
        """
        SELECT r.ticker,
               r.name,
               r.sector,
               r.industry,
               r.country,
               r.sort_order,
               q.last_price,
               q.currency        AS quote_currency,
               q.previous_close,
               q.fetched_at
        FROM research_tickers r
        LEFT JOIN stock_quotes q ON q.ticker = r.ticker
        ORDER BY r.sort_order, r.ticker
        """
    )

    # 2) Positions aggregated by ticker. Filtering server-side keeps
    #    the result tiny — only tickers the user holds come back.
    position_rows = db.fetch_all(
        """
        SELECT ticker,
               SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE 0 END) AS shares,
               MAX(currency) AS currency
        FROM stock_transactions
        WHERE ticker IN (SELECT ticker FROM research_tickers)
        GROUP BY ticker
        HAVING SUM(CASE WHEN transaction_type = 'buy' THEN quantity ELSE 0 END) > 0
        """
    )
    positions: dict[str, dict[str, Any]] = {
        p["ticker"]: {
            "shares": Decimal(p["shares"] or 0),
            "currency": p.get("currency") or "USD",
        }
        for p in position_rows
    }

    out: list[ResearchRow] = []
    for r in rows:
        last_price = (
            Decimal(r["last_price"]) if r.get("last_price") is not None else None
        )
        previous_close = (
            Decimal(r["previous_close"])
            if r.get("previous_close") is not None
            else None
        )
        day_change_pct: Decimal | None = None
        if last_price is not None and previous_close not in (None, Decimal(0)):
            day_change_pct = (
                ((last_price - previous_close) / previous_close) * Decimal(100)
            ).quantize(Decimal("0.01"))

        pos = positions.get(r["ticker"])
        position_shares = pos["shares"] if pos else Decimal(0)
        position_currency = pos["currency"] if pos else None
        position_value_native: Decimal | None = None
        position_value_cad: Decimal | None = None
        if pos and last_price is not None:
            position_value_native = (position_shares * last_price).quantize(
                Decimal("0.01")
            )
            # ``r["quote_currency"]`` is the currency of the price we
            # just multiplied by — that's what the value is denominated
            # in, regardless of the trade currency stored on the
            # transaction row.
            position_value_cad = _to_cad(
                position_value_native, r.get("quote_currency")
            )

        out.append(
            ResearchRow(
                ticker=r["ticker"],
                name=r["name"],
                sector=r["sector"],
                industry=r.get("industry"),
                country=r["country"],
                last_price=last_price,
                currency=r.get("quote_currency"),
                previous_close=previous_close,
                fetched_at=r.get("fetched_at"),
                day_change_pct=day_change_pct,
                position_shares=position_shares,
                position_currency=position_currency,
                position_value_native=position_value_native,
                position_value_cad=position_value_cad,
            )
        )

    return out


# ---------------------------------------------------------------------------
# POST /refresh/{ticker}
# ---------------------------------------------------------------------------


@router.post("/refresh/{ticker}", response_model=ResearchRow)
def refresh_one(ticker: str) -> ResearchRow:
    """Force-refresh the cached quote for one research ticker.

    Validates that the ticker is in the curated universe before
    spending a Twelve Data call so a typo on the wire doesn't drain
    the daily budget.
    """
    ticker = ticker.strip().upper()
    row = db.fetch_one(
        "SELECT ticker FROM research_tickers WHERE ticker = :ticker",
        {"ticker": ticker},
    )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "NOT_IN_RESEARCH",
                "message": f"Ticker {ticker!r} is not in the research universe.",
            },
        )

    try:
        get_quote(ticker, force_refresh=True)
    except QuoteUpstreamError as e:
        raise _quote_http(e) from e

    # Re-read this one row via the list endpoint's exact code path so
    # the response shape stays identical. Cheap (single PK lookup +
    # one position aggregate).
    fresh = [r for r in list_research() if r.ticker == ticker]
    if not fresh:
        # Defensive — the ticker was in research_tickers when we
        # checked but disappeared mid-flight. Shouldn't happen.
        raise HTTPException(
            status_code=500,
            detail={"code": "RESEARCH_ROW_MISSING", "ticker": ticker},
        )
    return fresh[0]
