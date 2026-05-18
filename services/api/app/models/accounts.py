"""Pydantic models for the unified Accounts page.

The Accounts page reads through ``GET /accounts``, which unions:

* YNAB-sourced accounts (``ynab_accounts``)
* Manual cash accounts (``manual_accounts``)
* Investment accounts (``investment_accounts``)

Each row is normalised to a common shape with source-specific fields
shoved into ``extra``. ``id`` is namespaced (``"ynab:..."`` / ``"manual:..."``
/ ``"investment:..."``) so the union remains unique even when underlying
IDs collide across sources.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AccountSource = Literal["ynab", "manual", "investment"]
AccountKind = Literal[
    "checking",
    "savings",
    "credit_card",
    "line_of_credit",
    "investing_fund",
    "investing_stock",
    "unassigned",
]
AccountOwner = Literal["personal", "business", "unassigned"]


class AccountRow(BaseModel):
    """One row in the unified Accounts list."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    source: AccountSource
    id: str
    """Namespaced id: ``"<source>:<underlying-id>"``."""

    name: str
    bank: str | None = None
    currency: str
    balance: Decimal
    """Native-currency balance (positive = asset, negative = liability)."""

    balance_cad: Decimal | None = None
    """``balance`` converted to CAD via the fx_rates cache. ``None``
    when the conversion failed (no FX cached for this currency)."""

    balance_as_of: date | None = None
    last_synced_at: datetime | None = None

    kind: AccountKind = "unassigned"
    owner: AccountOwner = "unassigned"

    is_editable: bool
    """``False`` for YNAB rows (upstream-owned); ``True`` for manual +
    investment rows."""

    is_active: bool = True

    extra: dict[str, Any] = Field(default_factory=dict)


class AccountListResponse(BaseModel):
    """Response shape for ``GET /accounts``."""

    accounts: list[AccountRow]


class AccountTagsUpdate(BaseModel):
    """Body for ``PATCH /accounts/{source}/{id}/tags``.

    Used for both YNAB rows (writes ``helm_kind`` / ``helm_owner``) and
    manual / investment rows (writes the equivalent columns). Both
    fields optional so the caller can update one without re-sending the
    other.
    """

    kind: AccountKind | None = None
    owner: AccountOwner | None = None
