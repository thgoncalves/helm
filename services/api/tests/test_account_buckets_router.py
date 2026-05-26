"""Tests for ``/accounts/buckets`` — user-defined category CRUD."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app import db as db_module


@pytest.fixture
def buckets_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """In-memory stand-in for the ``account_buckets`` table."""
    buckets: dict[UUID, dict[str, Any]] = {}
    stores: dict[str, Any] = {"account_buckets": buckets}

    def _next_sort_order() -> int:
        return max((b["sort_order"] for b in buckets.values()), default=-1) + 1

    def fetch_all(
        sql: str, params: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        sql = " ".join(sql.split())
        if "FROM account_buckets" in sql and "ORDER BY sort_order" in sql:
            return sorted(
                buckets.values(),
                key=lambda b: (b["sort_order"], b["name"]),
            )
        raise NotImplementedError(f"buckets_db.fetch_all: {sql[:140]}")

    def fetch_one(
        sql: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        sql = " ".join(sql.split())
        params = params or {}
        if "SELECT COALESCE(MAX(sort_order)" in sql:
            return {"next": _next_sort_order()}
        if "FROM account_buckets WHERE name = :name AND id <> :id" in sql:
            for b in buckets.values():
                if b["name"] == params["name"] and b["id"] != params["id"]:
                    return {"id": b["id"]}
            return None
        if "FROM account_buckets WHERE name = :name" in sql:
            for b in buckets.values():
                if b["name"] == params["name"]:
                    return {"id": b["id"]}
            return None
        if "FROM account_buckets WHERE id = :id" in sql:
            b = buckets.get(params["id"])
            return {"id": b["id"]} if b else None
        if sql.startswith("INSERT INTO account_buckets"):
            new_id = uuid4()
            now = datetime.now(timezone.utc)
            row = {
                "id": new_id,
                "name": params["name"],
                "color": params.get("color"),
                "sort_order": params["sort_order"],
                "created_at": now,
                "updated_at": now,
            }
            buckets[new_id] = row
            return row
        if sql.startswith("UPDATE account_buckets"):
            row = buckets.get(params["id"])
            if row is None:
                return None
            # Hand-parse SET assignments.
            m = re.search(r"SET (.+?) WHERE", sql, re.IGNORECASE)
            if m:
                for piece in m.group(1).split(","):
                    col, _, expr = (s.strip() for s in piece.partition("="))
                    if expr.startswith(":") and expr[1:] in params:
                        row[col] = params[expr[1:]]
            return row
        raise NotImplementedError(f"buckets_db.fetch_one: {sql[:140]}")

    def execute(sql: str, params: dict[str, Any] | None = None) -> dict:
        sql = " ".join(sql.split())
        params = params or {}
        if sql.startswith("DELETE FROM account_buckets"):
            buckets.pop(params["id"], None)
            return {}
        raise NotImplementedError(f"buckets_db.execute: {sql[:140]}")

    monkeypatch.setattr(db_module, "fetch_all", fetch_all)
    monkeypatch.setattr(db_module, "fetch_one", fetch_one)
    monkeypatch.setattr(db_module, "execute", execute)
    return stores


# ---------------------------------------------------------------------------
# GET /accounts/buckets
# ---------------------------------------------------------------------------


class TestListBuckets:
    def test_empty_initially(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        resp = client.get("/accounts/buckets")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_in_sort_order(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        client.post("/accounts/buckets", json={"name": "Daily"})
        client.post("/accounts/buckets", json={"name": "Emergency"})
        client.post("/accounts/buckets", json={"name": "Brazil"})
        body = client.get("/accounts/buckets").json()
        assert [b["name"] for b in body] == ["Daily", "Emergency", "Brazil"]
        # sort_order assigned 0, 1, 2 as they were created.
        assert [b["sort_order"] for b in body] == [0, 1, 2]


# ---------------------------------------------------------------------------
# POST /accounts/buckets
# ---------------------------------------------------------------------------


class TestCreateBucket:
    def test_creates_with_color(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        resp = client.post(
            "/accounts/buckets",
            json={"name": "Daily", "color": "amber"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Daily"
        assert body["color"] == "amber"

    def test_duplicate_name_409(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        client.post("/accounts/buckets", json={"name": "Daily"})
        resp = client.post("/accounts/buckets", json={"name": "Daily"})
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "BUCKET_NAME_EXISTS"

    def test_empty_name_rejected(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        resp = client.post("/accounts/buckets", json={"name": ""})
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# PATCH /accounts/buckets/{id}
# ---------------------------------------------------------------------------


class TestUpdateBucket:
    def test_rename(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        bid = client.post(
            "/accounts/buckets", json={"name": "Daily"}
        ).json()["id"]
        resp = client.patch(
            f"/accounts/buckets/{bid}",
            json={"name": "Daily spending"},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Daily spending"

    def test_rename_collision_409(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        client.post("/accounts/buckets", json={"name": "Daily"})
        other_bid = client.post(
            "/accounts/buckets", json={"name": "Emergency"}
        ).json()["id"]
        resp = client.patch(
            f"/accounts/buckets/{other_bid}",
            json={"name": "Daily"},
        )
        assert resp.status_code == 409

    def test_reorder(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        bid = client.post(
            "/accounts/buckets", json={"name": "Daily"}
        ).json()["id"]
        resp = client.patch(
            f"/accounts/buckets/{bid}", json={"sort_order": 5}
        )
        assert resp.status_code == 200
        assert resp.json()["sort_order"] == 5

    def test_404_when_missing(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        resp = client.patch(
            f"/accounts/buckets/{uuid4()}", json={"name": "X"}
        )
        assert resp.status_code == 404

    def test_empty_body_400(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        bid = client.post(
            "/accounts/buckets", json={"name": "Daily"}
        ).json()["id"]
        resp = client.patch(f"/accounts/buckets/{bid}", json={})
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# DELETE /accounts/buckets/{id}
# ---------------------------------------------------------------------------


class TestDeleteBucket:
    def test_deletes_existing(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        bid = client.post(
            "/accounts/buckets", json={"name": "Daily"}
        ).json()["id"]
        resp = client.delete(f"/accounts/buckets/{bid}")
        assert resp.status_code == 204
        assert buckets_db["account_buckets"] == {}

    def test_404_when_missing(
        self, client: TestClient, buckets_db: dict[str, Any]
    ) -> None:
        resp = client.delete(f"/accounts/buckets/{uuid4()}")
        assert resp.status_code == 404
