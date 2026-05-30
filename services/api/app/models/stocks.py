"""Pydantic models for the Stocks V1 surfaces."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Quote + history (read-only payloads)
# ---------------------------------------------------------------------------


class StockQuoteRead(BaseModel):
    ticker: str
    name: str | None = None
    exchange: str | None = None
    currency: str
    last_price: Decimal
    previous_close: Decimal | None = None
    fetched_at: datetime


class StockPricePoint(BaseModel):
    date: date
    close: Decimal


class StockSearchHit(BaseModel):
    ticker: str
    name: str | None = None
    exchange: str | None = None
    type: str | None = None


# ---------------------------------------------------------------------------
# Position in this stock — one row per account that holds it.
# ---------------------------------------------------------------------------


class StockPositionRow(BaseModel):
    """Per-(account, ticker) summary for the StockDetail page."""

    account_source: Literal["manual", "ynab"]
    account_id: UUID
    account_name: str
    account_kind: str | None = None  # itrade | tfsa | rrsp | corp | brazil

    quantity: Decimal
    acb_per_share: Decimal
    acb_total: Decimal
    currency: str
    #   ACB currency (matches the lots' trade currency).

    current_price: Decimal | None = None
    current_value: Decimal | None = None
    unrealized: Decimal | None = None
    unrealized_pct: Decimal | None = None


class StockDetailResponse(BaseModel):
    quote: StockQuoteRead
    history: list[StockPricePoint]
    positions: list[StockPositionRow]
    transactions: list["StockTransactionRead"]


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------


TransactionType = Literal["buy", "sell", "split", "dividend"]
AccountSource = Literal["manual", "ynab"]


class StockAccountRow(BaseModel):
    """Unified account list for the Stocks UI.

    Surfaces every account tagged ``helm_kind='investing_stock'`` across
    manual_accounts and ynab_accounts so the buy form can offer the
    user's *real* brokerage cash account (often a YNAB-synced row).
    """

    source: AccountSource
    id: UUID
    name: str
    bank: str | None = None
    kind: str | None = None
    #   "itrade" | "rrsp" | "tfsa" | "corp" | "brazil" for investment
    #   sources; the YNAB or manual kind otherwise.
    currency: str
    cash_balance: Decimal
    balance_as_of: date | None = None
    supports_cash_debit: bool
    #   True for manual rows where Helm owns the balance. False for
    #   YNAB rows (their balance comes from sync; we never write back).


class StockTransactionCreate(BaseModel):
    account_source: AccountSource = "manual"
    account_id: UUID
    ticker: str = Field(min_length=1, max_length=20)
    transaction_date: date
    quantity: Decimal = Field(gt=Decimal(0))
    unit_price: Decimal = Field(ge=Decimal(0))
    fees: Decimal = Field(default=Decimal(0), ge=Decimal(0))
    currency: str = Field(min_length=3, max_length=3)
    notes: str | None = None

    # V1 only writes "buy" rows; the field is here so the API can grow
    # without a schema change.
    transaction_type: TransactionType = "buy"

    # When True, the manual account's cash balance is debited by
    # quantity*unit_price + fees (or refunded on delete). Ignored for
    # ynab source — the YNAB sync owns those balances.
    auto_debit_cash: bool = True


class StockTransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_source: AccountSource
    account_id: UUID
    ticker: str
    transaction_type: TransactionType
    transaction_date: date
    quantity: Decimal
    unit_price: Decimal
    fees: Decimal
    currency: str
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


class FundsVsStocksRow(BaseModel):
    """One side of the Funds-vs-Stocks comparison strip."""

    bucket: Literal["funds", "stocks"]
    current_value_cad: Decimal
    accounts_count: int
    holdings_count: int = 0
    #   For stocks: number of distinct tickers. For funds: 0 (we don't
    #   track underlying holdings — just the balance snapshot).
    cost_basis_cad: Decimal | None = None
    #   Only available for stocks (sum of ACB across lots, FX-converted).
    unrealized_cad: Decimal | None = None
    unrealized_pct: Decimal | None = None
    stale_days: int | None = None
    #   For funds: max age of any balance_as_of in this bucket. Surfaces
    #   "your fund balances are X days old" so the comparison context is
    #   honest. None for stocks (always live via quote cache).


class FundsVsStocksResponse(BaseModel):
    funds: FundsVsStocksRow
    stocks: FundsVsStocksRow
    total_cad: Decimal
    funds_pct: Decimal
    stocks_pct: Decimal


class FundPerformanceRow(BaseModel):
    """One manual/YNAB investing fund's original vs current value.

    Funds have no cost-basis ledger, so the "original value" is taken
    from the earliest ``investing_snapshots`` row for this source — i.e.
    the value when Helm first started tracking it. ``original_*`` and the
    change fields are ``None`` until at least one snapshot exists.
    """

    source: Literal["manual", "ynab"]
    account_id: str  # namespaced "manual:<id>" / "ynab:<id>"
    label: str
    native_currency: str
    current_native: Decimal
    current_cad: Decimal
    original_cad: Decimal | None = None
    original_date: date | None = None
    change_cad: Decimal | None = None
    change_pct: Decimal | None = None
    base_currency: str = "CAD"


class StockPortfolioRow(BaseModel):
    """One row per held ticker for the Stocks landing page.

    Rolls up across all accounts (source × account) that hold the
    ticker. ``current_price`` and ``current_value`` come from the
    cached quote if available; ``None`` until first viewed on the
    detail page.

    The ``*_cad`` fields surface the same amounts converted to CAD via
    the BoC FX cache so the user can compare USD/BRL positions to their
    CAD ones at a glance. ``None`` when FX is unavailable.
    """

    ticker: str
    name: str | None = None
    accounts: int
    shares: Decimal
    acb_total: Decimal
    currency: str
    current_price: Decimal | None = None
    current_value: Decimal | None = None
    unrealized: Decimal | None = None
    # CAD-converted mirrors. Same as the native fields when currency is
    # already CAD. None on FX miss.
    acb_total_cad: Decimal | None = None
    current_value_cad: Decimal | None = None
    unrealized_cad: Decimal | None = None
    # When this ticker's cached quote was last fetched (stock_quotes.fetched_at).
    # None when no quote has been cached yet.
    current_price_as_of: datetime | None = None


class RefreshPricesResult(BaseModel):
    """Summary of a bulk force-refresh of all held tickers' quotes.

    Partial failures don't fail the whole request — ``failed`` and
    ``errors`` report which tickers couldn't be refreshed so the UI can
    say e.g. "5 of 7 refreshed".
    """

    refreshed: int
    failed: int
    max_fetched_at: datetime | None = None
    errors: list[str] = Field(default_factory=list)


StockDetailResponse.model_rebuild()
