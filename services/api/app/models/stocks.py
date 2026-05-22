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

    account_source: Literal["investment", "manual", "ynab"]
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
AccountSource = Literal["investment", "manual", "ynab"]


class StockAccountRow(BaseModel):
    """Unified account list for the Stocks UI.

    Surfaces every account tagged ``helm_kind='investing_stock'`` across
    the three sources Helm aggregates on the Accounts page so the buy
    form can offer the user's *real* brokerage cash account (often a
    YNAB-synced row) instead of forcing a dupe under
    ``investment_accounts``.
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
    #   True for investment + manual sources where Helm owns the balance.
    #   False for YNAB rows (their balance comes from sync; we never
    #   write back to YNAB).


class StockTransactionCreate(BaseModel):
    account_source: AccountSource = "investment"
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

    # When True, the brokerage account's cash balance is debited by
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


class StockPortfolioRow(BaseModel):
    """One row per held ticker for the Stocks landing page.

    Rolls up across all accounts (source × account) that hold the
    ticker. ``current_price`` and ``current_value`` come from the
    cached quote if available; ``None`` until first viewed on the
    detail page.
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


StockDetailResponse.model_rebuild()
