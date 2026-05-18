"""Pydantic models for the Investments module."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Asset class enum — shared between holdings + target allocations.
# ---------------------------------------------------------------------------


class AssetClass(StrEnum):
    EQUITY_CA = "equity_ca"
    EQUITY_US = "equity_us"
    EQUITY_INTERNATIONAL = "equity_international"
    BONDS = "bonds"
    CASH = "cash"
    ALTERNATIVE = "alternative"
    REAL_ESTATE = "real_estate"
    CRYPTO = "crypto"
    OTHER = "other"


AccountKind = Literal["itrade", "rrsp", "tfsa", "brazil", "corp"]


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


class InvestmentAccountBase(BaseModel):
    name: str = Field(min_length=1)
    kind: AccountKind
    currency: str = Field(min_length=3, max_length=3, default="CAD")
    owner_label: str | None = None
    contribution_limit: Decimal | None = None
    notes: str | None = None
    is_active: bool = True


class InvestmentAccountCreate(InvestmentAccountBase):
    pass


class InvestmentAccountUpdate(BaseModel):
    name: str | None = None
    kind: AccountKind | None = None
    currency: str | None = None
    owner_label: str | None = None
    contribution_limit: Decimal | None = None
    notes: str | None = None
    is_active: bool | None = None


class InvestmentAccountRead(InvestmentAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Holdings
# ---------------------------------------------------------------------------


class InvestmentHoldingBase(BaseModel):
    ticker: str = Field(min_length=1, max_length=24)
    asset_class: AssetClass
    shares: Decimal = Field(gt=0)
    avg_cost: Decimal = Field(ge=0)
    current_price: Decimal = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    as_of: date
    notes: str | None = None


class InvestmentHoldingCreate(InvestmentHoldingBase):
    account_id: UUID


class InvestmentHoldingUpdate(BaseModel):
    ticker: str | None = None
    asset_class: AssetClass | None = None
    shares: Decimal | None = None
    avg_cost: Decimal | None = None
    current_price: Decimal | None = None
    currency: str | None = None
    as_of: date | None = None
    notes: str | None = None


class InvestmentHoldingRead(InvestmentHoldingBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_id: UUID
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Target allocations
# ---------------------------------------------------------------------------


class TargetAllocationRow(BaseModel):
    asset_class: AssetClass
    target_pct: Decimal = Field(ge=0, le=100)


class TargetAllocationsPut(BaseModel):
    """Atomic replace — full set in, full set out.

    The API enforces that ``SUM(target_pct) == 100``. Asset classes
    not present in the payload are deleted from the table.
    """

    targets: list[TargetAllocationRow]


# ---------------------------------------------------------------------------
# Portfolio rollup
# ---------------------------------------------------------------------------


class PortfolioTotals(BaseModel):
    market_value: Decimal
    cost_basis: Decimal
    unrealized: Decimal
    unrealized_pct: Decimal | None = None


class PortfolioByKind(BaseModel):
    kind: AccountKind
    market_value: Decimal
    share_pct: Decimal | None = None


class PortfolioAllocationRow(BaseModel):
    asset_class: AssetClass
    market_value: Decimal
    actual_pct: Decimal
    target_pct: Decimal | None = None
    drift_pct: Decimal | None = None


class PortfolioHolding(BaseModel):
    id: UUID
    account_id: UUID
    account_name: str
    account_kind: AccountKind
    ticker: str
    asset_class: AssetClass
    shares: Decimal
    avg_cost: Decimal
    current_price: Decimal
    currency: str
    market_value_native: Decimal
    market_value_cad: Decimal
    unrealized: Decimal
    unrealized_pct: Decimal | None = None
    as_of: date


class PortfolioFxUsed(BaseModel):
    """One FX rate that contributed to the rollup."""

    pair: str  # e.g. "BRL_CAD"
    rate: Decimal
    rate_date: date


class PortfolioResponse(BaseModel):
    as_of: date
    currency: str
    totals: PortfolioTotals
    by_account_kind: list[PortfolioByKind]
    allocation: list[PortfolioAllocationRow]
    holdings: list[PortfolioHolding]
    fx_rates_used: list[PortfolioFxUsed]


# ---------------------------------------------------------------------------
# FX rate response (used by manual refresh endpoint)
# ---------------------------------------------------------------------------


class FxRateRead(BaseModel):
    from_currency: str
    to_currency: str
    rate_date: date
    rate: Decimal


# ---------------------------------------------------------------------------
# Contributions
# ---------------------------------------------------------------------------


ContributionKind = Literal["deposit", "withdrawal"]


class InvestmentContributionBase(BaseModel):
    contributed_on: date
    kind: ContributionKind = "deposit"
    amount: Decimal = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)
    notes: str | None = None


class InvestmentContributionCreate(InvestmentContributionBase):
    pass


class InvestmentContributionUpdate(BaseModel):
    contributed_on: date | None = None
    kind: ContributionKind | None = None
    amount: Decimal | None = None
    currency: str | None = None
    notes: str | None = None


class InvestmentContributionRead(InvestmentContributionBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_id: UUID
    fx_rate_cad: Decimal
    amount_cad: Decimal  # Signed by kind.
    created_at: datetime
    updated_at: datetime


class ContributionRoom(BaseModel):
    """One row in the registered-room widget on the Overview."""

    account_id: UUID
    account_name: str
    account_kind: AccountKind
    currency: str
    contribution_limit: Decimal
    contributed_ytd: Decimal
    remaining: Decimal
