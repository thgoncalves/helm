"""Tests for per-account daily balance snapshots.

Covers the capture writer (:func:`record_account_snapshots`) and the
reader (:func:`fetch_history`) behind the Accounts 30-day sparkline.

Rather than fake the whole ynab/manual account surface, we stub the two
account loaders the writer reuses and back ``app.db`` with a tiny
in-memory snapshot store that models the ``ON CONFLICT`` upsert.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest

from app import db as db_module
from app.models.accounts import AccountRow
from app.money.account_snapshots import fetch_history, record_account_snapshots


def _row(account_id: str, source: str, balance: str, cad: str | None) -> AccountRow:
    return AccountRow(
        source=source,  # type: ignore[arg-type]
        id=account_id,
        name=account_id,
        currency="CAD",
        balance=Decimal(balance),
        balance_cad=None if cad is None else Decimal(cad),
        is_editable=source == "manual",
    )


@pytest.fixture
def snap_store(monkeypatch: pytest.MonkeyPatch) -> dict[tuple[date, str], dict[str, Any]]:
    """In-memory ``account_balance_snapshots`` keyed by (date, account_id)."""
    store: dict[tuple[date, str], dict[str, Any]] = {}

    def execute(sql: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = params or {}
        if "INSERT INTO account_balance_snapshots" in sql:
            key = (params["snapshot_date"], params["account_id"])
            store[key] = dict(params)  # upsert: overwrite models ON CONFLICT
        return {}

    def fetch_all(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        params = params or {}
        if "FROM account_balance_snapshots" in sql:
            return [
                {
                    "snapshot_date": r["snapshot_date"],
                    "native_amount": r["native_amount"],
                    "cad_amount": r["cad_amount"],
                }
                for (d, aid), r in store.items()
                if aid == params["account_id"] and d >= params["start"]
            ]
        raise AssertionError(f"unexpected fetch_all: {sql[:80]}")

    monkeypatch.setattr(db_module, "execute", execute)
    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    return store


def test_records_one_row_per_account_and_is_idempotent(
    snap_store: dict[tuple[date, str], dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ynab = [
        _row("ynab:a1", "ynab", "100.00", "100.00"),
        _row("ynab:a2", "ynab", "-50.00", "-50.00"),
    ]
    manual = [_row("manual:m1", "manual", "300.00", "81.00")]
    monkeypatch.setattr(
        "app.routers.accounts._load_ynab_rows", lambda: ynab, raising=True
    )
    monkeypatch.setattr(
        "app.routers.accounts._load_manual_rows", lambda: manual, raising=True
    )

    record_account_snapshots()
    assert len(snap_store) == 3  # one row per account, today

    # Second call same day upserts in place — no duplicate rows.
    record_account_snapshots()
    assert len(snap_store) == 3

    # The writer keys snapshots by the UTC date, so assert on the same
    # basis — otherwise this flakes at the local/UTC day boundary.
    today = datetime.now(timezone.utc).date()
    assert snap_store[(today, "ynab:a1")]["native_amount"] == Decimal("100.00")
    assert snap_store[(today, "manual:m1")]["cad_amount"] == Decimal("81.00")


def test_fetch_history_returns_window_oldest_first(
    snap_store: dict[tuple[date, str], dict[str, Any]],
) -> None:
    today = date.today()
    # Seed three days for one account + an out-of-window day + another account.
    for offset, amount in [(2, "100"), (1, "110"), (0, "120"), (40, "5")]:
        d = today - timedelta(days=offset)
        snap_store[(d, "ynab:a1")] = {
            "snapshot_date": d,
            "native_amount": Decimal(amount),
            "cad_amount": Decimal(amount),
        }
    snap_store[(today, "ynab:other")] = {
        "snapshot_date": today,
        "native_amount": Decimal("999"),
        "cad_amount": Decimal("999"),
    }

    out = fetch_history("ynab:a1", 30)
    # 3 in-window points (the 40-days-ago one excluded), other account excluded.
    assert [p["native_amount"] for p in out] == [
        Decimal("100"),
        Decimal("110"),
        Decimal("120"),
    ]
    # Oldest first.
    assert out[0]["snapshot_date"] < out[-1]["snapshot_date"]


def test_fetch_history_empty_for_unknown_account(
    snap_store: dict[tuple[date, str], dict[str, Any]],
) -> None:
    assert fetch_history("ynab:nope", 30) == []
