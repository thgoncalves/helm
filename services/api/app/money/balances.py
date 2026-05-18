"""Shared balance aggregation.

Computes CAD-converted balances across the three account sources
(YNAB-cached, manual, investment). Used by the live ``/money/health``
endpoint and by the snapshot writer that captures the same numbers to
``net_worth_snapshots`` for the trend chart.

Keeping the math in one place means a snapshot and a live KPI computed
moments apart always agree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app import db
from app.investments.fx import FxRateUnavailable, get_rate

_MILLI = Decimal(1000)

ASSET_KINDS = frozenset(
    {"checking", "savings", "investing_fund", "investing_stock"}
)
LIABILITY_KINDS = frozenset({"credit_card", "line_of_credit"})
CASH_KINDS = frozenset({"checking", "savings"})

# YNAB's account types we auto-map to Helm kinds when ``helm_kind`` is
# still unset on a YNAB row. Mirrors the table in
# ``app.routers.accounts``.
YNAB_TYPE_TO_KIND: dict[str, str] = {
    "checking": "checking",
    "savings": "savings",
    "lineOfCredit": "line_of_credit",
    "creditCard": "credit_card",
}


@dataclass
class Balances:
    """Aggregated CAD totals + per-owner asset / liability breakdown.

    ``by_kind`` is keyed on the Helm taxonomy
    (``checking | savings | investing_fund | investing_stock | credit_card | line_of_credit``).
    Liabilities are stored as POSITIVE numbers — the dashboard renders
    them with a minus sign at the boundary.
    """

    by_kind: dict[str, Decimal] = field(default_factory=dict)
    personal_assets: Decimal = Decimal("0")
    personal_liabilities: Decimal = Decimal("0")
    business_assets: Decimal = Decimal("0")
    business_liabilities: Decimal = Decimal("0")
    warnings: list[str] = field(default_factory=list)

    @property
    def assets_cad(self) -> Decimal:
        return sum(
            (v for k, v in self.by_kind.items() if k in ASSET_KINDS),
            Decimal("0"),
        )

    @property
    def liabilities_cad(self) -> Decimal:
        return sum(
            (v for k, v in self.by_kind.items() if k in LIABILITY_KINDS),
            Decimal("0"),
        )

    @property
    def cash_cad(self) -> Decimal:
        return sum(
            (v for k, v in self.by_kind.items() if k in CASH_KINDS),
            Decimal("0"),
        )

    @property
    def investing_cad(self) -> Decimal:
        return self.by_kind.get(
            "investing_fund", Decimal("0")
        ) + self.by_kind.get("investing_stock", Decimal("0"))

    @property
    def lending_cad(self) -> Decimal:
        return self.by_kind.get(
            "credit_card", Decimal("0")
        ) + self.by_kind.get("line_of_credit", Decimal("0"))


def compute_balances() -> Balances:
    """Read every active account row, CAD-convert, return the totals."""
    b = Balances()

    def _add(kind: str, owner: str | None, amount_cad: Decimal) -> None:
        b.by_kind[kind] = b.by_kind.get(kind, Decimal("0")) + amount_cad
        if owner == "personal":
            if kind in ASSET_KINDS:
                b.personal_assets += amount_cad
            elif kind in LIABILITY_KINDS:
                b.personal_liabilities += amount_cad
        elif owner == "business":
            if kind in ASSET_KINDS:
                b.business_assets += amount_cad
            elif kind in LIABILITY_KINDS:
                b.business_liabilities += amount_cad

    # YNAB rows: milliunits, in budget currency.
    budgets = db.fetch_all(
        "SELECT id, currency_code FROM ynab_budgets WHERE is_active = TRUE"
    )
    ccy_by_budget = {
        b_row["id"]: (b_row.get("currency_code") or "CAD")
        for b_row in budgets
    }
    ynab_rows = db.fetch_all(
        """
        SELECT *
        FROM ynab_accounts
        WHERE closed = FALSE AND deleted = FALSE
        """
    )
    for row in ynab_rows:
        currency = ccy_by_budget.get(row.get("budget_id") or "", "CAD")
        balance = Decimal(int(row.get("balance") or 0)) / _MILLI
        kind = row.get("helm_kind") or YNAB_TYPE_TO_KIND.get(
            row.get("type") or "", "unassigned"
        )
        if kind in LIABILITY_KINDS:
            balance = abs(balance)
        cad = _to_cad(balance, currency, b.warnings)
        if cad is None:
            continue
        _add(kind, row.get("helm_owner"), cad)

    # Manual cash accounts.
    manual_rows = db.fetch_all(
        "SELECT * FROM manual_accounts WHERE is_active = TRUE"
    )
    for row in manual_rows:
        balance = Decimal(row.get("balance") or 0)
        currency = row.get("currency") or "CAD"
        kind = row.get("kind") or "unassigned"
        if kind in LIABILITY_KINDS:
            balance = abs(balance)
        cad = _to_cad(balance, currency, b.warnings)
        if cad is None:
            continue
        _add(kind, row.get("owner"), cad)

    # Investment accounts: cash + holdings (shares × current_price).
    inv_rows = db.fetch_all(
        "SELECT * FROM investment_accounts WHERE is_active = TRUE"
    )
    for row in inv_rows:
        currency = row.get("currency") or "CAD"
        cash_balance = Decimal(row.get("cash_balance") or 0)
        holdings_total = _holdings_total(row["id"])
        total = cash_balance + holdings_total
        kind = row.get("helm_kind") or "investing_fund"
        cad = _to_cad(total, currency, b.warnings)
        if cad is None:
            continue
        _add(kind, row.get("owner"), cad)

    return b


def _holdings_total(account_id: Any) -> Decimal:
    row = db.fetch_one(
        """
        SELECT COALESCE(SUM(shares * current_price), 0) AS total
        FROM investment_holdings
        WHERE account_id = :id
        """,
        {"id": account_id},
    )
    return Decimal(row.get("total") or 0) if row else Decimal("0")


def _to_cad(
    amount: Decimal, currency: str, warnings: list[str]
) -> Decimal | None:
    if (currency or "").upper() == "CAD":
        return amount
    try:
        rate = get_rate(currency, "CAD")
    except FxRateUnavailable:
        warnings.append(
            f"FX rate unavailable for {currency}→CAD; "
            f"some balances excluded from totals."
        )
        return None
    return amount * rate.rate
