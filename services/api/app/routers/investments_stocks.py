"""Stocks V1.1 — self-managed equity tracking endpoints.

Mounts under ``/investments/stocks``.

Routes:

* ``GET    /search?q=…``         Twelve Data symbol autocomplete proxy.
* ``GET    /accounts``           Unified list of all accounts tagged
                                 ``helm_kind='investing_stock'`` across
                                 investment_accounts, manual_accounts,
                                 and ynab_accounts. The buy form uses
                                 this so YNAB-synced brokerage cash
                                 accounts (the real iTrade-Cash etc.)
                                 show up alongside any Helm-native ones.
* ``GET    /{ticker}``           Quote + 1Y history + positions + lots.
* ``POST   /transactions``       Record a buy. Cash debit only fires for
                                 investment + manual sources.
* ``GET    /transactions``       List lots, filterable by account.
* ``DELETE /transactions/{id}``  Remove a lot; reverses the cash
                                 debit (when applicable) and recomputes
                                 the position.
* ``POST   /refresh-quote/{ticker}``  Force a quote refresh.

The investment_holdings row is *only* maintained when the buy is
against an ``investment_accounts`` row — for ynab/manual sources the
position is computed at read time from stock_transactions so we don't
keep a stale cache that the legacy /investments/portfolio endpoint
can't see anyway.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.investments.stocks_quotes import (
    QuoteApiKeyMissing,
    QuoteRateLimited,
    QuoteUpstreamError,
    TickerNotFound,
    get_history,
    get_quote,
    search_symbols,
)
from app.models.stocks import (
    StockAccountRow,
    StockDetailResponse,
    StockPortfolioRow,
    StockPositionRow,
    StockPricePoint,
    StockQuoteRead,
    StockSearchHit,
    StockTransactionCreate,
    StockTransactionRead,
)

router = APIRouter(tags=["investments"], dependencies=[Depends(get_current_user)])

AccountSource = Literal["investment", "manual", "ynab"]


# ---------------------------------------------------------------------------
# Yahoo / Twelve Data error → HTTP shape
# ---------------------------------------------------------------------------


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
    if isinstance(exc, QuoteApiKeyMissing):
        return HTTPException(
            status_code=503,
            detail={"code": "QUOTE_API_KEY_MISSING", "message": str(exc)},
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
               q.name       AS quote_name
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
        out.append(
            StockPortfolioRow(
                ticker=agg["ticker"],
                name=agg["name"],
                accounts=len(agg["accounts"]),
                shares=agg["shares"],
                acb_total=agg["cost"].quantize(Decimal("0.01")),
                currency=agg["currency"],
                current_price=quote_price,
                current_value=current_value,
                unrealized=unrealized,
            )
        )
    out.sort(key=lambda r: (r.current_value or Decimal(0)), reverse=True)
    return out


# ---------------------------------------------------------------------------
# Unified accounts list
# ---------------------------------------------------------------------------


@router.get("/accounts", response_model=list[StockAccountRow])
def list_stock_accounts() -> list[StockAccountRow]:
    out: list[StockAccountRow] = []

    # investment_accounts — helm_kind tagged stocks. The brokerage's
    # cash sits on the same row (cash_balance / cash_currency).
    inv_rows = db.fetch_all(
        """
        SELECT id, name, bank, kind, currency, cash_balance, cash_currency,
               balance_as_of
        FROM investment_accounts
        WHERE is_active = TRUE
          AND helm_kind = 'investing_stock'
        ORDER BY name
        """
    )
    for r in inv_rows:
        out.append(
            StockAccountRow(
                source="investment",
                id=r["id"],
                name=r["name"],
                bank=r.get("bank"),
                kind=r.get("kind"),
                currency=r.get("cash_currency") or r["currency"],
                cash_balance=Decimal(r["cash_balance"] or 0),
                balance_as_of=r.get("balance_as_of"),
                supports_cash_debit=True,
            )
        )

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
    # the Money/Accounts page.
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

    account = _fetch_account_or_404(body.account_source, body.account_id)
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

    # Cash debit only applies to Helm-owned sources. YNAB cash is
    # owned by the YNAB sync and we never write back.
    if body.auto_debit_cash and body.account_source in ("investment", "manual"):
        cost = body.quantity * body.unit_price + body.fees
        _adjust_cash(body.account_source, body.account_id, -cost, now.date())

    # The investment_holdings cache is only meaningful for
    # investment-source rows (the legacy portfolio endpoint reads
    # that table). Other sources compute positions at read time.
    if body.account_source == "investment":
        _recompute_position(body.account_id, ticker)

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
    source = row.get("account_source") or "investment"
    cost = (
        Decimal(row["quantity"]) * Decimal(row["unit_price"]) + Decimal(row["fees"])
    )
    db.execute(
        "DELETE FROM stock_transactions WHERE id = :id",
        {"id": transaction_id},
    )
    if source in ("investment", "manual"):
        _adjust_cash(source, row["account_id"], cost, date.today())
    if source == "investment":
        _recompute_position(row["account_id"], row["ticker"])


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
    "investment": "investment_accounts",
    "manual": "manual_accounts",
    "ynab": "ynab_accounts",
}


def _fetch_account_or_404(source: AccountSource, account_id: UUID) -> dict[str, Any]:
    table = _ACCOUNT_TABLE.get(source)
    if table is None:
        raise HTTPException(status_code=400, detail=f"Unknown account source '{source}'.")
    # ynab_accounts.id is stored as text (YNAB returns UUID strings via
    # its public API); the other two tables use uuid columns. Pass the
    # value as a string and cast in the SQL so both shapes match.
    row = db.fetch_one(
        f"SELECT * FROM {table} WHERE id = :id",
        {"id": str(account_id) if source == "ynab" else account_id},
    )
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"Account not found in {table}."
        )
    return row


def _infer_asset_class(ticker: str) -> str:
    upper = ticker.upper()
    if upper.endswith(".TO") or upper.endswith(".V") or upper.endswith(".CN"):
        return "equity_ca"
    if "." in upper:
        return "equity_international"
    return "equity_us"


def _adjust_cash(
    source: AccountSource, account_id: UUID, delta: Decimal, as_of: date
) -> None:
    """Add ``delta`` (signed) to the account's cash field.

    Investment + manual sources are owned by Helm; YNAB is read-only
    (the sync is the source of truth) so callers should never invoke
    this for source='ynab'.
    """
    if source == "investment":
        row = db.fetch_one(
            "SELECT cash_balance FROM investment_accounts WHERE id = :id",
            {"id": account_id},
        )
        if row is None:
            return
        new_balance = Decimal(row["cash_balance"] or 0) + delta
        db.execute(
            """
            UPDATE investment_accounts
            SET cash_balance = :balance,
                balance_as_of = :as_of,
                updated_at = NOW()
            WHERE id = :id
            """,
            {"id": account_id, "balance": new_balance, "as_of": as_of},
        )
    elif source == "manual":
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
    # ynab: no-op (caller should not invoke).


def _recompute_position(account_id: UUID, ticker: str) -> None:
    """Re-derive investment_holdings from the matching stock_transactions.

    Only called for source='investment' rows so the legacy
    /investments/portfolio endpoint sees them. Positions for the
    Stocks UI itself are computed by ``_positions_for_ticker`` from
    stock_transactions across all sources.
    """
    rows = db.fetch_all(
        """
        SELECT transaction_type, quantity, unit_price, fees, currency
        FROM stock_transactions
        WHERE account_source = 'investment'
          AND account_id = :account_id
          AND ticker = :ticker
        """,
        {"account_id": account_id, "ticker": ticker},
    )
    total_shares = Decimal(0)
    total_cost = Decimal(0)
    currency = "USD"
    for r in rows:
        qty = Decimal(r["quantity"])
        price = Decimal(r["unit_price"])
        fees = Decimal(r["fees"] or 0)
        currency = r["currency"] or currency
        if r["transaction_type"] == "buy":
            total_shares += qty
            total_cost += qty * price + fees

    existing = db.fetch_one(
        """
        SELECT id FROM investment_holdings
        WHERE account_id = :account_id AND ticker = :ticker
        """,
        {"account_id": account_id, "ticker": ticker},
    )

    if total_shares <= 0:
        if existing is not None:
            db.execute(
                "DELETE FROM investment_holdings WHERE id = :id",
                {"id": existing["id"]},
            )
        return

    avg_cost = (total_cost / total_shares).quantize(Decimal("0.0001"))

    quote_row = db.fetch_one(
        "SELECT last_price FROM stock_quotes WHERE ticker = :ticker",
        {"ticker": ticker},
    )
    current_price = (
        Decimal(quote_row["last_price"]) if quote_row else avg_cost
    )

    if existing is None:
        db.execute(
            """
            INSERT INTO investment_holdings
              (account_id, ticker, asset_class, shares, avg_cost,
               current_price, currency, as_of, created_at, updated_at)
            VALUES
              (:account_id, :ticker, :asset_class, :shares, :avg_cost,
               :current_price, :currency, :as_of, NOW(), NOW())
            """,
            {
                "account_id": account_id,
                "ticker": ticker,
                "asset_class": _infer_asset_class(ticker),
                "shares": total_shares,
                "avg_cost": avg_cost,
                "current_price": current_price,
                "currency": currency,
                "as_of": date.today(),
            },
        )
    else:
        db.execute(
            """
            UPDATE investment_holdings
            SET shares = :shares,
                avg_cost = :avg_cost,
                current_price = :current_price,
                currency = :currency,
                as_of = :as_of,
                updated_at = NOW()
            WHERE id = :id
            """,
            {
                "id": existing["id"],
                "shares": total_shares,
                "avg_cost": avg_cost,
                "current_price": current_price,
                "currency": currency,
                "as_of": date.today(),
            },
        )


def _account_label(source: AccountSource, account_id: UUID) -> tuple[str, str | None]:
    """Look up the display name + kind for an (source, id) tuple."""
    if source == "investment":
        row = db.fetch_one(
            "SELECT name, kind FROM investment_accounts WHERE id = :id",
            {"id": account_id},
        )
        if row:
            return row["name"], row.get("kind")
    elif source == "manual":
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
