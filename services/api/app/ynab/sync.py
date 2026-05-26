"""Refresh-on-demand: pull YNAB → upsert into the local Postgres cache.

Called from :func:`POST /money/ynab/refresh`. Single budget by design —
the user marks one budget as active and Helm tracks only that one.

Strategy:

1. Fetch budgets, mark the chosen one ``is_active=True`` (and others
   ``False``). Stamp ``last_synced_at``.
2. Upsert the budget's account list (name, type, balances). The
   Helm-side ``helm_kind`` / ``helm_owner`` tags are preserved across
   syncs — only the upstream-controlled columns refresh.
3. Upsert the category catalogue (groups + categories, hidden flag).
4. Upsert the current month's category amounts.
5. Upsert the last ``TRANSACTION_WINDOW_DAYS`` of transactions so the
   dashboard's pacing chart has the data it needs without pulling the
   entire transaction history every refresh.

YNAB's amounts are signed milliunits (CAD 12.34 = 12340; outflows are
negative). We store them as-is in BIGINT columns and let the dashboard
endpoint do dollar conversion at serialisation time.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app import db
from app.money.snapshots import record_snapshot
from app.ynab.client import YnabClient

TRANSACTION_WINDOW_DAYS = 60


@dataclass(frozen=True)
class SyncResult:
    """Counters returned by :func:`refresh`. Used in API responses + logs."""

    budget_id: str
    budget_name: str
    accounts_upserted: int
    categories_upserted: int
    month_rows_upserted: int
    transactions_upserted: int
    synced_at: datetime


def refresh(
    *,
    client: YnabClient,
    budget_id: str | None = None,
) -> SyncResult:
    """Pull YNAB data and upsert into the cache.

    Args:
        client: Initialised :class:`YnabClient`.
        budget_id: When given, picks this budget. Otherwise picks the
            currently-active budget from the local cache, falling back
            to YNAB's first budget on first-run.

    Returns:
        :class:`SyncResult` summarising the upsert counters.
    """
    now = datetime.now(timezone.utc)

    target_id = budget_id or _active_or_first_budget(client)
    budgets = client.list_budgets()
    summary = next((b for b in budgets if b["id"] == target_id), None)
    if summary is None:
        raise ValueError(
            f"Budget {target_id!r} not found in the user's YNAB account."
        )

    # 1) Budgets — mark chosen active, all others inactive.
    db.execute("UPDATE ynab_budgets SET is_active = FALSE")
    db.execute(
        """
        INSERT INTO ynab_budgets (
            id, name, last_modified_on, currency_code, is_active,
            last_synced_at, created_at
        )
        VALUES (
            :id, :name, :last_modified_on, :currency_code, TRUE,
            :now, :now
        )
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            last_modified_on = EXCLUDED.last_modified_on,
            currency_code = EXCLUDED.currency_code,
            is_active = TRUE,
            last_synced_at = EXCLUDED.last_synced_at
        """,
        {
            "id": summary["id"],
            "name": summary.get("name") or summary["id"],
            "last_modified_on": _parse_dt(summary.get("last_modified_on")),
            "currency_code": (
                summary.get("currency_format", {}).get("iso_code") or "CAD"
            ),
            "now": now,
        },
    )

    # 2) Accounts — cache the budget's account list. Upstream columns
    # refresh on every sync; the Helm-side ``helm_kind`` / ``helm_owner``
    # (and ``bucket_id`` / ``sort_index`` once 0022 lands) are mutated
    # only by the Accounts page and never overwritten here — they're
    # not in the EXCLUDED set.
    accounts = client.get_accounts(target_id)
    account_param_sets = [
        {
            "id": acct["id"],
            "budget_id": target_id,
            "name": acct.get("name") or "",
            "type": acct.get("type") or "otherAsset",
            "on_budget": bool(acct.get("on_budget", True)),
            "closed": bool(acct.get("closed", False)),
            "deleted": bool(acct.get("deleted", False)),
            "balance": int(acct.get("balance") or 0),
            "cleared_balance": int(acct.get("cleared_balance") or 0),
            "uncleared_balance": int(acct.get("uncleared_balance") or 0),
            "now": now,
        }
        for acct in accounts
    ]
    db.execute_many(
        """
        INSERT INTO ynab_accounts (
            id, budget_id, name, type,
            on_budget, closed, deleted,
            balance, cleared_balance, uncleared_balance,
            last_synced_at
        )
        VALUES (
            :id, :budget_id, :name, :type,
            :on_budget, :closed, :deleted,
            :balance, :cleared_balance, :uncleared_balance,
            :now
        )
        ON CONFLICT (id) DO UPDATE SET
            budget_id = EXCLUDED.budget_id,
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            on_budget = EXCLUDED.on_budget,
            closed = EXCLUDED.closed,
            deleted = EXCLUDED.deleted,
            balance = EXCLUDED.balance,
            cleared_balance = EXCLUDED.cleared_balance,
            uncleared_balance = EXCLUDED.uncleared_balance,
            last_synced_at = EXCLUDED.last_synced_at
        """,
        account_param_sets,
    )
    accounts_upserted = len(account_param_sets)

    # 3) Categories (and groups).
    groups = client.get_categories(target_id)
    category_param_sets = [
        {
            "category_id": cat["id"],
            "budget_id": target_id,
            "group_name": group.get("name") or "",
            "name": cat.get("name") or "",
            "hidden": bool(cat.get("hidden") or group.get("hidden")),
            "now": now,
        }
        for group in groups
        for cat in (group.get("categories", []) or [])
    ]
    db.execute_many(
        """
        INSERT INTO ynab_categories (
            category_id, budget_id, group_name, name, hidden,
            last_synced_at
        )
        VALUES (
            :category_id, :budget_id, :group_name, :name, :hidden,
            :now
        )
        ON CONFLICT (category_id) DO UPDATE SET
            budget_id = EXCLUDED.budget_id,
            group_name = EXCLUDED.group_name,
            name = EXCLUDED.name,
            hidden = EXCLUDED.hidden,
            last_synced_at = EXCLUDED.last_synced_at
        """,
        category_param_sets,
    )
    categories_upserted = len(category_param_sets)

    # 4) Current month — assigned / activity / balance per category.
    month_str = date.today().replace(day=1).isoformat()
    month_detail = client.get_month(target_id, month_str)
    month_categories = month_detail.get("categories", []) or []
    month_param_sets = [
        {
            "budget_id": target_id,
            "month": date.fromisoformat(month_str),
            "category_id": cat["id"],
            "assigned": int(cat.get("budgeted") or 0),
            "activity": int(cat.get("activity") or 0),
            "balance": int(cat.get("balance") or 0),
            "now": now,
        }
        for cat in month_categories
    ]
    db.execute_many(
        """
        INSERT INTO ynab_month_categories (
            budget_id, month, category_id,
            assigned, activity, balance, last_synced_at
        )
        VALUES (
            :budget_id, :month, :category_id,
            :assigned, :activity, :balance, :now
        )
        ON CONFLICT (budget_id, month, category_id) DO UPDATE SET
            assigned = EXCLUDED.assigned,
            activity = EXCLUDED.activity,
            balance = EXCLUDED.balance,
            last_synced_at = EXCLUDED.last_synced_at
        """,
        month_param_sets,
    )
    month_rows = len(month_param_sets)

    # 5) Recent transactions — last TRANSACTION_WINDOW_DAYS days.
    # Split deleted (DELETE) from live (UPSERT); each goes into its own
    # batch so we only emit two SQL statements regardless of how many
    # rows YNAB sent.
    since = (date.today() - timedelta(days=TRANSACTION_WINDOW_DAYS)).isoformat()
    txns = client.get_transactions(target_id, since_date=since)
    deleted_param_sets: list[dict[str, Any]] = []
    txn_param_sets: list[dict[str, Any]] = []
    for txn in txns:
        if txn.get("deleted"):
            deleted_param_sets.append({"id": txn["id"]})
            continue
        txn_param_sets.append(
            {
                "id": txn["id"],
                "budget_id": target_id,
                "account_id": txn.get("account_id") or "",
                "posted_date": date.fromisoformat(txn["date"]),
                "amount": int(txn.get("amount") or 0),
                "payee_name": txn.get("payee_name"),
                "memo": txn.get("memo"),
                "category_id": txn.get("category_id"),
                "transfer_account_id": txn.get("transfer_account_id"),
                "cleared": txn.get("cleared") or "uncleared",
                "approved": bool(txn.get("approved", True)),
                "now": now,
            }
        )
    db.execute_many(
        "DELETE FROM ynab_transactions WHERE id = :id",
        deleted_param_sets,
    )
    db.execute_many(
        """
        INSERT INTO ynab_transactions (
            id, budget_id, account_id, posted_date, amount,
            payee_name, memo, category_id, transfer_account_id,
            cleared, approved, last_synced_at
        )
        VALUES (
            :id, :budget_id, :account_id, :posted_date, :amount,
            :payee_name, :memo, :category_id, :transfer_account_id,
            :cleared, :approved, :now
        )
        ON CONFLICT (id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            posted_date = EXCLUDED.posted_date,
            amount = EXCLUDED.amount,
            payee_name = EXCLUDED.payee_name,
            memo = EXCLUDED.memo,
            category_id = EXCLUDED.category_id,
            transfer_account_id = EXCLUDED.transfer_account_id,
            cleared = EXCLUDED.cleared,
            approved = EXCLUDED.approved,
            last_synced_at = EXCLUDED.last_synced_at
        """,
        txn_param_sets,
    )
    txn_rows = len(txn_param_sets)

    # Capture a net-worth snapshot now that the YNAB balances are fresh.
    # Safe even when accounts haven't changed — the helper upserts on
    # snapshot_month and swallows its own errors.
    record_snapshot()

    return SyncResult(
        budget_id=target_id,
        budget_name=summary.get("name") or target_id,
        accounts_upserted=accounts_upserted,
        categories_upserted=categories_upserted,
        month_rows_upserted=month_rows,
        transactions_upserted=txn_rows,
        synced_at=now,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _active_or_first_budget(client: YnabClient) -> str:
    row = db.fetch_one(
        "SELECT id FROM ynab_budgets WHERE is_active = TRUE LIMIT 1"
    )
    if row and row.get("id"):
        return str(row["id"])
    budgets = client.list_budgets()
    if not budgets:
        raise ValueError(
            "No budgets returned from YNAB. Has the PAT been authorised "
            "against an account with at least one budget?"
        )
    return budgets[0]["id"]


def _parse_dt(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        # YNAB returns ISO 8601 with a trailing 'Z'.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
