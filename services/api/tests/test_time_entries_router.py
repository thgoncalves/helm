"""Integration tests for /business/time-entries.

Covers the bulk upsert path, which is the only write surface the timesheet
page exercises.
"""

from datetime import date

from fastapi.testclient import TestClient

from tests.conftest import SEED_ID_1


def _bulk_payload(
    *,
    entries: list[tuple[str, str]],
    period_start: str = "2026-05-01",
    period_end: str = "2026-05-31",
    client_id: str = str(SEED_ID_1),
) -> dict:
    """Build a PUT /bulk body from (date, hours) pairs."""
    return {
        "client_id": client_id,
        "period_start": period_start,
        "period_end": period_end,
        "entries": [
            {"work_date": d, "hours": h} for (d, h) in entries
        ],
    }


class TestListTimeEntries:
    def test_returns_empty_list_for_empty_period(self, client: TestClient) -> None:
        response = client.get(
            "/business/time-entries/",
            params={
                "client_id": str(SEED_ID_1),
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
        assert response.status_code == 200
        assert response.json() == []

    def test_returns_only_rows_in_range(self, client: TestClient) -> None:
        # Seed two months via bulk upsert.
        client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(
                entries=[("2026-04-15", "5.0"), ("2026-05-02", "3.0")],
                period_start="2026-04-01",
                period_end="2026-05-31",
            ),
        )
        response = client.get(
            "/business/time-entries/",
            params={
                "client_id": str(SEED_ID_1),
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["work_date"] == "2026-05-02"


class TestBulkUpsert:
    def test_inserts_new_entries(self, client: TestClient) -> None:
        response = client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(
                entries=[("2026-05-04", "4.0"), ("2026-05-06", "3.0")],
            ),
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        by_date = {row["work_date"]: row["hours"] for row in data}
        assert by_date["2026-05-04"] == "4.00"
        assert by_date["2026-05-06"] == "3.00"

    def test_updates_existing_entry(self, client: TestClient) -> None:
        client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(entries=[("2026-05-04", "4.0")]),
        )
        # Re-send with a different value.
        response = client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(entries=[("2026-05-04", "8.0")]),
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["hours"] == "8.00"

    def test_zero_hours_deletes_row(self, client: TestClient) -> None:
        client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(entries=[("2026-05-04", "4.0")]),
        )
        response = client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(entries=[("2026-05-04", "0")]),
        )
        assert response.status_code == 200
        assert response.json() == []

    def test_missing_dates_in_period_are_deleted(self, client: TestClient) -> None:
        # Seed two entries.
        client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(
                entries=[("2026-05-04", "4.0"), ("2026-05-05", "5.0")],
            ),
        )
        # Re-send only one — the other should be deleted.
        response = client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(entries=[("2026-05-05", "5.0")]),
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["work_date"] == "2026-05-05"

    def test_period_start_after_end_returns_400(
        self, client: TestClient
    ) -> None:
        response = client.put(
            "/business/time-entries/bulk",
            json=_bulk_payload(
                entries=[],
                period_start="2026-05-31",
                period_end="2026-05-01",
            ),
        )
        assert response.status_code == 400
