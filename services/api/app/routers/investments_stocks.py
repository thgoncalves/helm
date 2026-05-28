"""Stocks V1 — self-managed equity tracking endpoints.

Mounts under ``/investments/stocks``.

Routes:

* ``GET    /search?q=…``         Yahoo Finance symbol autocomplete proxy.
* ``GET    /accounts``           Unified list of accounts tagged
                                 ``helm_kind='investing_stock'`` across
                                 manual_accounts and ynab_accounts. The
                                 buy form uses this so YNAB-synced
                                 brokerage cash accounts (the real
                                 iTrade-Cash etc.) show up alongside
                                 Helm-native ones.
* ``GET    /comparison``         Funds vs Stocks summary.
* ``GET    /positions``          One row per held ticker (landing page).
* ``GET    /{ticker}``           Quote + 1Y history + positions + lots.
* ``POST   /transactions``       Record a buy. Cash debit only fires for
                                 the manual source.
* ``GET    /transactions``       List lots, filterable by account.
* ``DELETE /transactions/{id}``  Remove a lot; reverses the cash
                                 debit (when applicable).
* ``POST   /refresh-quote/{ticker}``  Force a quote refresh.

Positions are computed at read time from ``stock_transactions`` — there
is no per-row holdings cache.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.investments.fx import get_rate as fx_rate
from app.investments.stocks_quotes import (
    QuoteRateLimited,
    QuoteUpstreamError,
    TickerNotFound,
    get_history,
    get_quote,
    search_symbols,
)
from app.models.stocks import (
    FundsVsStocksResponse,
    FundsVsStocksRow,
    StockAccountRow,
    StockDetailResponse,
    StockPortfolioRow,
    StockPositionRow,
    StockPricePoint,
    StockQuoteRead,
    StockSearchHit,
    StockTransactionCreate,
    StockTransactionRead,
    RefreshPricesResult,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

AccountSource = Literal["manual", "ynab"]


def _quote_http(exc: QuoteUpstreamError) -> HTTPException:
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
                "message": (
                    "Price provider is rate-limiting us. Wait a few minutes "
                    "and try again, or enter the price manually on the buy form."
                ),
            },
        )
    return HTTPException(
        status_code=502,
        detail={"code": "QUOTE_UPSTREAM", "message": str(exc)},
    )


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@router.get("/search", response_model=list[StockSearchHit])
def search(q: str = Query(..., min_length=1)) -> list[StockSearchHit]:
    try:
        hits = search_symbols(q)
    except QuoteUpstreamError as e:
        raise _quote_http(e) from e
    return [
        StockSearchHit(
            ticker=h.ticker, name=h.name, exchange=h.exchange, type=h.type
        )
        for h in hits
    ]


# ---------------------------------------------------------------------------
# Funds vs Stocks comparison
# ---------------------------------------------------------------------------


_BASE_CCY = "CAD"


def _to_cad(amount: Decimal, currency: str) -> Decimal:
    if not amount:
        return Decimal(0)
    if (currency or "CAD").upper() == _BASE_CCY:
        return amount
    try:
        rate = fx_rate(currency.upper(), _BASE_CCY).rate
    except Exception:  # noqa: BLE001 — FX is best-effort here
        return amount
    return (amount * rate).quantize(Decimal("0.01"))


def _to_cad_strict(amount: Decimal | None, currency: str) -> Decimal | None:
    """CAD conversion that signals FX miss instead of silently identity-ing.

    Returns ``amount`` unchanged when the currency is CAD, ``None`` when
    FX is unavailable, and the converted Decimal otherwise. Use this on
    the per-row API responses where the UI needs to know the conversion
    actually happened.
    """
    if amount is None:
        return None
    if (currency or "CAD").upper() == _BASE_CCY:
        return amount
    try:
        rate = fx_rate(currency.upper(), _BASE_CCY).rate
    except Exception:  # noqa: BLE001 — FX is best-effort here
        return None
    return (amount * rate).quantize(Decimal("0.01"))


@router.get("/comparison", response_model=FundsVsStocksResponse)
def comparison() -> FundsVsStocksResponse:
    """Side-by-side Funds vs Stocks summary for the Investments page.

    Funds = every account tagged ``helm_kind='investing_fund'`` across
    manual_accounts and ynab_accounts. Their balance is the "current
    value"; cost basis is not tracked, so unrealized isn't computed.

    Stocks = aggregated stock_transactions across all sources, valued
    at the most recent cached quote.
    """
    today = date.today()

    # ---- Funds --------------------------------------------------------
    funds_value = Decimal(0)
    funds_accounts = 0
    funds_oldest_age: int | None = None

    for row in db.fetch_all(
        """
        SELECT balance, currency, balance_as_of
        FROM manual_accounts
        WHERE is_active = TRUE
          AND kind = 'investing_fund'
        """
    ):
        funds_accounts += 1
        funds_value += _to_cad(
            Decimal(row["balance"] or 0), row.get("currency") or "CAD"
        )
        funds_oldest_age = _max_age(funds_oldest_age, row.get("balance_as_of"), today)

    for row in db.fetch_all(
        """
        SELECT balance
        FROM ynab_accounts
        WHERE closed = FALSE
          AND deleted = FALSE
          AND helm_kind = 'investing_fund'
        """
    ):
        funds_accounts += 1
        # YNAB balance is in milliunits — assume CAD (matches the
        # tagging convention; non-CAD YNAB budgets would need FX).
        funds_value += Decimal(row["balance"] or 0) / Decimal(1000)

    # ---- Stocks -------------------------------------------------------
    stock_rows = db.fetch_all(
        """
        SELECT t.ticker, t.account_source, t.account_id, t.transaction_type,
               t.quantity, t.unit_price, t.fees, t.currency,
               q.last_price AS quote_price, q.currency AS quote_ccy
        FROM stock_transactions t
        LEFT JOIN stock_quotes q ON q.ticker = t.ticker
        """
    )
    by_ticker: dict[str, dict[str, Any]] = {}
    accounts_seen: set[tuple[str, str]] = set()
    for r in stock_rows:
        accounts_seen.add((r["account_source"], str(r["account_id"])))
        agg = by_ticker.setdefault(
            r["ticker"],
            {
                "shares": Decimal(0),
                "cost": Decimal(0),
                "ccy": r["currency"] or "USD",
                "quote_price": r.get("quote_price"),
                "quote_ccy": r.get("quote_ccy") or r["currency"] or "USD",
            },
        )
        qty = Decimal(r["quantity"])
        price = Decimal(r["unit_price"])
        fees = Decimal(r["fees"] or 0)
        if r["transaction_type"] == "buy":
            agg["shares"] += qty
            agg["cost"] += qty * price + fees

    stocks_cost_cad = Decimal(0)
    stocks_value_cad = Decimal(0)
    tickers_held = 0
    for agg in by_ticker.values():
        if agg["shares"] <= 0:
            continue
        tickers_held += 1
        stocks_cost_cad += _to_cad(agg["cost"], agg["ccy"])
        if agg["quote_price"] is not None:
            mv = agg["shares"] * Decimal(agg["quote_price"])
            stocks_value_cad += _to_cad(mv, agg["quote_ccy"])
        else:
            # No cached quote yet — fall back to ACB so the bucket has
            # *some* value. The Stocks page surfaces the missing quote
            # explicitly.
            stocks_value_cad += _to_cad(agg["cost"], agg["ccy"])

    stocks_unrealized = (stocks_value_cad - stocks_cost_cad).quantize(Decimal("0.01"))
    stocks_pct = (
        (stocks_unrealized / stocks_cost_cad * Decimal(100)).quantize(Decimal("0.01"))
        if stocks_cost_cad > 0
        else None
    )

    total = funds_value + stocks_value_cad
    funds_share = (
        (funds_value / total * Decimal(100)).quantize(Decimal("0.01"))
        if total > 0
        else Decimal(0)
    )
    stocks_share = (
        (stocks_value_cad / total * Decimal(100)).quantize(Decimal("0.01"))
        if total > 0
        else Decimal(0)
    )

    return FundsVsStocksResponse(
        funds=FundsVsStocksRow(
            bucket="funds",
            current_value_cad=funds_value.quantize(Decimal("0.01")),
            accounts_count=funds_accounts,
            holdings_count=0,
            cost_basis_cad=None,
            unrealized_cad=None,
            unrealized_pct=None,
            stale_days=funds_oldest_age,
        ),
        stocks=FundsVsStocksRow(
            bucket="stocks",
            current_value_cad=stocks_value_cad.quantize(Decimal("0.01")),
            accounts_count=len(accounts_seen),
            holdings_count=tickers_held,
            cost_basis_cad=stocks_cost_cad.quantize(Decimal("0.01")),
            unrealized_cad=stocks_unrealized,
            unrealized_pct=stocks_pct,
            stale_days=None,
        ),
        total_cad=total.quantize(Decimal("0.01")),
        funds_pct=funds_share,
        stocks_pct=stocks_share,
    )


def _max_age(current: int | None, as_of: Any, today: date) -> int | None:
    if as_of is None:
        return current
    if not isinstance(as_of, date):
        try:
            as_of = date.fromisoformat(str(as_of))
        except ValueError:
            return current
    age = (today - as_of).days
    if current is None or age > current:
        return age
    return current


# ---------------------------------------------------------------------------
# Portfolio rollup — every held ticker across all account sources
# ---------------------------------------------------------------------------


@router.get("/positions", response_model=list[StockPortfolioRow])
def list_positions() -> list[StockPortfolioRow]:
    """One row per held ticker, summed across all (source, account).

    Powers the Stocks landing page. Quote / value columns come from
    the local ``stock_quotes`` cache — no upstream call here so the
    landing page renders instantly even when the price API is slow.
    """
    rows = db.fetch_all(
        """
        SELECT t.ticker,
               t.account_source,
               t.account_id,
               t.transaction_type,
               t.quantity,
               t.unit_price,
               t.fees,
               t.currency,
               q.last_price AS quote_price,
               q.name       AS quote_name,
               q.fetched_at AS quote_fetched_at
        FROM stock_transactions t
        LEFT JOIN stock_quotes q ON q.ticker = t.ticker
        """
    )
    by_ticker: dict[str, dict[str, Any]] = {}
    for r in rows:
        ticker = r["ticker"]
        agg = by_ticker.get(ticker)
        if agg is None:
            agg = by_ticker[ticker] = {
                "ticker": ticker,
                "name": r.get("quote_name"),
                "shares": Decimal(0),
                "cost": Decimal(0),
                "currency": r.get("currency") or "USD",
                "quote_price": r.get("quote_price"),
                "quote_as_of": r.get("quote_fetched_at"),
                "accounts": set(),
            }
        agg["accounts"].add((r["account_source"], str(r["account_id"])))
        qty = Decimal(r["quantity"])
        price = Decimal(r["unit_price"])
        fees = Decimal(r["fees"] or 0)
        if r["transaction_type"] == "buy":
            agg["shares"] += qty
            agg["cost"] += qty * price + fees

    out: list[StockPortfolioRow] = []
    for agg in by_ticker.values():
        if agg["shares"] <= 0:
            continue
        quote_price = (
            Decimal(agg["quote_price"]) if agg["quote_price"] is not None else None
        )
        current_value = (
            (agg["shares"] * quote_price).quantize(Decimal("0.01"))
            if quote_price is not None
            else None
        )
        unrealized = (
            (current_value - agg["cost"]).quantize(Decimal("0.01"))
            if current_value is not None
            else None
        )
        acb_total = agg["cost"].quantize(Decimal("0.01"))
        currency = agg["currency"]
        out.append(
            StockPortfolioRow(
                ticker=agg["ticker"],
                name=agg["name"],
                accounts=len(agg["accounts"]),
                shares=agg["shares"],
                acb_total=acb_total,
                currency=currency,
                current_price=quote_price,
                current_value=current_value,
                unrealized=unrealized,
                acb_total_cad=_to_cad_strict(acb_total, currency),
                current_value_cad=_to_cad_strict(current_value, currency),
                unrealized_cad=_to_cad_strict(unrealized, currency),
                current_price_as_of=agg["quote_as_of"],
            )
        )
    out.sort(
        key=lambda r: (r.current_value_cad or r.current_value or Decimal(0)),
        reverse=True,
    )
    return out


# ---------------------------------------------------------------------------
# Unified accounts list
# ---------------------------------------------------------------------------


@router.get("/accounts", response_model=list[StockAccountRow])
def list_stock_accounts() -> list[StockAccountRow]:
    out: list[StockAccountRow] = []

    # manual_accounts — Brazilian-style cash on hand. ``balance`` is
    # the cash field; user-owned so debit is fine.
    manual_rows = db.fetch_all(
        """
        SELECT id, name, bank, kind, currency, balance, balance_as_of
        FROM manual_accounts
        WHERE is_active = TRUE
          AND kind = 'investing_stock'
        ORDER BY name
        """
    )
    for r in manual_rows:
        out.append(
            StockAccountRow(
                source="manual",
                id=r["id"],
                name=r["name"],
                bank=r.get("bank"),
                kind="manual",
                currency=r["currency"],
                cash_balance=Decimal(r["balance"] or 0),
                balance_as_of=r.get("balance_as_of"),
                supports_cash_debit=True,
            )
        )

    # ynab_accounts — YNAB-synced brokerage cash. Balance is owned by
    # YNAB; we surface it but don't write back. helm_kind tag set on
    # the Accounts page.
    ynab_rows = db.fetch_all(
        """
        SELECT id, name, type, balance
        FROM ynab_accounts
        WHERE closed = FALSE
          AND deleted = FALSE
          AND helm_kind = 'investing_stock'
        ORDER BY name
        """
    )
    for r in ynab_rows:
        # YNAB stores balance in milliunits (×1000) with CAD assumed
        # for the helm-tagged accounts in the user's setup.
        bal = Decimal(r["balance"] or 0) / Decimal(1000)
        out.append(
            StockAccountRow(
                source="ynab",
                id=r["id"],
                name=r["name"],
                bank=None,
                kind=r.get("type"),
                currency="CAD",
                cash_balance=bal,
                balance_as_of=None,
                supports_cash_debit=False,
            )
        )

    return out


# ---------------------------------------------------------------------------
# Refresh quote
# ---------------------------------------------------------------------------


@router.post("/refresh-quote/{ticker}", response_model=StockQuoteRead)
def refresh_quote(ticker: str) -> StockQuoteRead:
    try:
        q = get_quote(ticker, force_refresh=True)
    except QuoteUpstreamError as e:
        raise _quote_http(e) from e
    return StockQuoteRead(
        ticker=q.ticker,
        name=q.name,
        exchange=q.exchange,
        currency=q.currency,
        last_price=q.last_price,
        previous_close=q.previous_close,
        fetched_at=q.fetched_at,
    )


@router.post("/refresh-prices", response_model=RefreshPricesResult)
def refresh_prices() -> RefreshPricesResult:
    """Force-refresh the cached quote for every held ticker.

    Partial failures (a single ticker rate-limited or not found) don't
    fail the whole request — they're tallied into ``failed``/``errors``
    so the page can report "5 of 7 refreshed". ``get_quote`` is a
    blocking httpx call, so we fan out across a small thread pool; the
    RDS Data API client in ``app.db`` is stateless and safe to call from
    worker threads.
    """
    rows = db.fetch_all("SELECT DISTINCT ticker FROM stock_transactions")
    tickers = [r["ticker"] for r in rows if r.get("ticker")]
    if not tickers:
        return RefreshPricesResult(refreshed=0, failed=0)

    refreshed = 0
    failed = 0
    errors: list[str] = []
    max_at: datetime | None = None

    with ThreadPoolExecutor(max_workers=min(8, len(tickers))) as ex:
        futures = {
            ex.submit(get_quote, t, force_refresh=True): t for t in tickers
        }
        for fut in as_completed(futures):
            ticker = futures[fut]
            try:
                q = fut.result()
            except QuoteUpstreamError as e:
                failed += 1
                if len(errors) < 5:
                    detail = getattr(e, "detail", None) or str(e)
                    errors.append(f"{ticker}: {detail}")
                continue
            refreshed += 1
            if q.fetched_at is not None and (max_at is None or q.fetched_at > max_at):
                max_at = q.fetched_at

    return RefreshPricesResult(
        refreshed=refreshed,
        failed=failed,
        max_fetched_at=max_at,
        errors=errors,
    )


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------


@router.get("/transactions", response_model=list[StockTransactionRead])
def list_transactions(
    account_id: UUID | None = Query(None),
    account_source: AccountSource | None = Query(None),
    ticker: str | None = Query(None),
) -> list[StockTransactionRead]:
    where: list[str] = []
    params: dict[str, Any] = {}
    if account_id is not None:
        where.append("account_id = :account_id")
        params["account_id"] = account_id
    if account_source is not None:
        where.append("account_source = :account_source")
        params["account_source"] = account_source
    if ticker is not None:
        where.append("ticker = :ticker")
        params["ticker"] = ticker
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    rows = db.fetch_all(
        f"""
        SELECT * FROM stock_transactions
        {where_sql}
        ORDER BY transaction_date DESC, created_at DESC
        """,
        params,
    )
    return [StockTransactionRead(**r) for r in rows]


@router.post(
    "/transactions",
    response_model=StockTransactionRead,
    status_code=201,
)
def create_transaction(body: StockTransactionCreate) -> StockTransactionRead:
    if body.transaction_type != "buy":
        raise HTTPException(
            status_code=400,
            detail="Only 'buy' transactions are supported in V1.",
        )

    _fetch_account_or_404(body.account_source, body.account_id)
    ticker = body.ticker.strip().upper()
    txn_id = uuid4()
    now = datetime.now(timezone.utc)

    db.execute(
        """
        INSERT INTO stock_transactions
          (id, account_source, account_id, ticker, transaction_type,
           transaction_date, quantity, unit_price, fees, currency, notes,
           created_at, updated_at)
        VALUES
          (:id, :account_source, :account_id, :ticker, :transaction_type,
           :transaction_date, :quantity, :unit_price, :fees, :currency,
           :notes, :created_at, :updated_at)
        """,
        {
            "id": txn_id,
            "account_source": body.account_source,
            "account_id": body.account_id,
            "ticker": ticker,
            "transaction_type": "buy",
            "transaction_date": body.transaction_date,
            "quantity": body.quantity,
            "unit_price": body.unit_price,
            "fees": body.fees,
            "currency": body.currency.upper(),
            "notes": body.notes,
            "created_at": now,
            "updated_at": now,
        },
    )

    # Cash debit only applies to manual accounts. YNAB cash is owned
    # by the YNAB sync and we never write back.
    if body.auto_debit_cash and body.account_source == "manual":
        cost = body.quantity * body.unit_price + body.fees
        _adjust_cash(body.account_id, -cost, now.date())

    row = db.fetch_one(
        "SELECT * FROM stock_transactions WHERE id = :id", {"id": txn_id}
    )
    assert row is not None
    return StockTransactionRead(**row)


@router.delete("/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: UUID) -> None:
    row = db.fetch_one(
        "SELECT * FROM stock_transactions WHERE id = :id",
        {"id": transaction_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Transaction not found.")
    source = row.get("account_source") or "manual"
    cost = (
        Decimal(row["quantity"]) * Decimal(row["unit_price"]) + Decimal(row["fees"])
    )
    db.execute(
        "DELETE FROM stock_transactions WHERE id = :id",
        {"id": transaction_id},
    )
    if source == "manual":
        _adjust_cash(row["account_id"], cost, date.today())


# ---------------------------------------------------------------------------
# Detail page — quote + history + positions + lots
# ---------------------------------------------------------------------------


@router.get("/{ticker}", response_model=StockDetailResponse)
def get_detail(ticker: str) -> StockDetailResponse:
    ticker = ticker.strip().upper()
    try:
        quote = get_quote(ticker)
        history = get_history(ticker, days=365)
    except QuoteUpstreamError as e:
        raise _quote_http(e) from e

    txn_rows = db.fetch_all(
        """
        SELECT * FROM stock_transactions
        WHERE ticker = :ticker
        ORDER BY transaction_date DESC, created_at DESC
        """,
        {"ticker": ticker},
    )
    transactions = [StockTransactionRead(**r) for r in txn_rows]

    positions = _positions_for_ticker(ticker, quote_price=quote.last_price)

    return StockDetailResponse(
        quote=StockQuoteRead(
            ticker=quote.ticker,
            name=quote.name,
            exchange=quote.exchange,
            currency=quote.currency,
            last_price=quote.last_price,
            previous_close=quote.previous_close,
            fetched_at=quote.fetched_at,
        ),
        history=[StockPricePoint(date=p.date, close=p.close) for p in history],
        positions=positions,
        transactions=transactions,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_ACCOUNT_TABLE = {
    "manual": "manual_accounts",
    "ynab": "ynab_accounts",
}


def _fetch_account_or_404(source: AccountSource, account_id: UUID) -> dict[str, Any]:
    table = _ACCOUNT_TABLE.get(source)
    if table is None:
        raise HTTPException(status_code=400, detail=f"Unknown account source '{source}'.")
    # ynab_accounts.id is stored as text (YNAB returns UUID strings via
    # its public API); manual_accounts uses uuid. Pass the value as a
    # string for ynab and the uuid for manual.
    row = db.fetch_one(
        f"SELECT * FROM {table} WHERE id = :id",
        {"id": str(account_id) if source == "ynab" else account_id},
    )
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"Account not found in {table}."
        )
    return row


def _adjust_cash(account_id: UUID, delta: Decimal, as_of: date) -> None:
    """Add ``delta`` (signed) to a manual account's cash balance."""
    row = db.fetch_one(
        "SELECT balance FROM manual_accounts WHERE id = :id",
        {"id": account_id},
    )
    if row is None:
        return
    new_balance = Decimal(row["balance"] or 0) + delta
    db.execute(
        """
        UPDATE manual_accounts
        SET balance = :balance,
            balance_as_of = :as_of,
            updated_at = NOW()
        WHERE id = :id
        """,
        {"id": account_id, "balance": new_balance, "as_of": as_of},
    )


def _account_label(source: AccountSource, account_id: UUID) -> tuple[str, str | None]:
    """Look up the display name + kind for an (source, id) tuple."""
    if source == "manual":
        row = db.fetch_one(
            "SELECT name, kind FROM manual_accounts WHERE id = :id",
            {"id": account_id},
        )
        if row:
            return row["name"], row.get("kind")
    elif source == "ynab":
        row = db.fetch_one(
            "SELECT name, type FROM ynab_accounts WHERE id = :id",
            {"id": str(account_id)},
        )
        if row:
            return row["name"], row.get("type")
    return "Unknown account", None


def _positions_for_ticker(
    ticker: str, *, quote_price: Decimal
) -> list[StockPositionRow]:
    """Aggregate stock_transactions across all sources for ``ticker``."""
    rows = db.fetch_all(
        """
        SELECT account_source, account_id, transaction_type, quantity,
               unit_price, fees, currency
        FROM stock_transactions
        WHERE ticker = :ticker
        ORDER BY account_source, account_id
        """,
        {"ticker": ticker},
    )
    by_key: dict[tuple[str, UUID], dict[str, Any]] = {}
    for r in rows:
        key = (r["account_source"], r["account_id"])
        if key not in by_key:
            name, kind = _account_label(r["account_source"], r["account_id"])
            by_key[key] = {
                "source": r["account_source"],
                "account_id": r["account_id"],
                "account_name": name,
                "account_kind": kind,
                "shares": Decimal(0),
                "cost": Decimal(0),
                "currency": r["currency"],
            }
        agg = by_key[key]
        qty = Decimal(r["quantity"])
        price = Decimal(r["unit_price"])
        fees = Decimal(r["fees"] or 0)
        if r["transaction_type"] == "buy":
            agg["shares"] += qty
            agg["cost"] += qty * price + fees

    out: list[StockPositionRow] = []
    for agg in by_key.values():
        if agg["shares"] <= 0:
            continue
        acb_per_share = (agg["cost"] / agg["shares"]).quantize(Decimal("0.0001"))
        current_value = (agg["shares"] * quote_price).quantize(Decimal("0.01"))
        unrealized = (current_value - agg["cost"]).quantize(Decimal("0.01"))
        pct = (
            (unrealized / agg["cost"] * Decimal(100)).quantize(Decimal("0.01"))
            if agg["cost"] > 0
            else None
        )
        out.append(
            StockPositionRow(
                account_source=agg["source"],
                account_id=agg["account_id"],
                account_name=agg["account_name"],
                account_kind=agg["account_kind"],
                quantity=agg["shares"],
                acb_per_share=acb_per_share,
                acb_total=agg["cost"].quantize(Decimal("0.01")),
                currency=agg["currency"],
                current_price=quote_price,
                current_value=current_value,
                unrealized=unrealized,
                unrealized_pct=pct,
            )
        )
    return out
