"""Integration tests for the /business/clients router.

Uses FastAPI's synchronous TestClient (via httpx under the hood).

Seed UUIDs (reset before each test via the ``reset_clients_store`` autouse fixture):
  - 00000000-0000-0000-0000-000000000001  Sulpetro   (active)
  - 00000000-0000-0000-0000-000000000002  Wenco      (active)
  - 00000000-0000-0000-0000-000000000003  Nutrien    (archived / is_active=False)
"""

import uuid

import pytest
from fastapi.testclient import TestClient

# Seed IDs match the deterministic UUIDs in app/routers/clients.py
SEED_ID_1 = "00000000-0000-0000-0000-000000000001"  # Sulpetro
SEED_ID_2 = "00000000-0000-0000-0000-000000000002"  # Wenco
SEED_ID_3 = "00000000-0000-0000-0000-000000000003"  # Nutrien (archived)
RANDOM_UUID = str(uuid.uuid4())


class TestListClients:
    def test_returns_200_and_active_clients_by_default(
        self, client: TestClient
    ) -> None:
        """GET /business/clients returns 200 with only the 2 active clients."""
        response = client.get("/business/clients/")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2

    def test_active_list_excludes_nutrien(self, client: TestClient) -> None:
        """Default list does not include the archived Nutrien client."""
        response = client.get("/business/clients/")
        ids = [c["id"] for c in response.json()]
        assert SEED_ID_3 not in ids

    def test_include_archived_returns_all_seeds(
        self, client: TestClient
    ) -> None:
        """GET /business/clients?include_archived=true returns all 4 seed clients."""
        response = client.get("/business/clients/?include_archived=true")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 4

    def test_archived_list_includes_nutrien(self, client: TestClient) -> None:
        """include_archived=true result contains Nutrien (is_active=False)."""
        response = client.get("/business/clients/?include_archived=true")
        ids = [c["id"] for c in response.json()]
        assert SEED_ID_3 in ids

    def test_response_includes_expected_fields(self, client: TestClient) -> None:
        """Each client in the list has id, name, and created_at fields."""
        response = client.get("/business/clients/")
        clients = response.json()
        for c in clients:
            assert "id" in c
            assert "name" in c
            assert "created_at" in c
            # Validate id is a valid UUID string
            uuid.UUID(c["id"])


class TestGetClient:
    def test_returns_200_for_known_seed_id(self, client: TestClient) -> None:
        """GET /business/clients/{id} returns 200 for a seeded client."""
        response = client.get(f"/business/clients/{SEED_ID_1}")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == SEED_ID_1
        assert data["name"] == "Sulpetro"

    def test_returns_correct_client_data(self, client: TestClient) -> None:
        """Detail response contains the expected field values for Sulpetro."""
        response = client.get(f"/business/clients/{SEED_ID_1}")
        data = response.json()
        assert data["email"] == "ckingsford@sulpetro.com"
        assert data["phone"] == "(403) 619-7785"
        assert data["city"] == "Calgary"
        assert data["state"] == "Alberta"
        assert data["country"] == "Canada"
        assert data["is_active"] is True

    def test_returns_404_for_unknown_uuid(self, client: TestClient) -> None:
        """GET /business/clients/{random-uuid} returns 404."""
        response = client.get(f"/business/clients/{RANDOM_UUID}")
        assert response.status_code == 404


class TestCreateClient:
    def test_returns_201_with_id_and_timestamps(self, client: TestClient) -> None:
        """POST /business/clients returns 201 with UUID id and timestamps."""
        payload = {
            "name": "New Test Client",
            "email": "test@newclient.example.com",
            "hourly_rate": "200.00",
            "is_active": True,
        }
        response = client.post("/business/clients/", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "New Test Client"
        # id should be a valid UUID
        uuid.UUID(data["id"])
        # timestamps should be present and non-null
        assert "created_at" in data
        assert "updated_at" in data
        assert data["created_at"] is not None
        assert data["updated_at"] is not None

    def test_new_client_defaults_is_active_true(self, client: TestClient) -> None:
        """POST response has is_active=True even when not explicitly sent."""
        response = client.post(
            "/business/clients/", json={"name": "Implicit Active"}
        )
        assert response.status_code == 201
        assert response.json()["is_active"] is True

    def test_created_client_appears_in_list(self, client: TestClient) -> None:
        """Client created via POST appears in the subsequent GET list."""
        unique_name = f"Listed Client {uuid.uuid4().hex[:8]}"
        client.post("/business/clients/", json={"name": unique_name})
        response = client.get("/business/clients/")
        names = [c["name"] for c in response.json()]
        assert unique_name in names

    def test_missing_name_returns_422(self, client: TestClient) -> None:
        """POST without required 'name' field returns 422 Unprocessable Entity."""
        payload = {
            "email": "nope@example.com",
            "hourly_rate": "150.00",
        }
        response = client.post("/business/clients/", json=payload)
        assert response.status_code == 422
        errors = response.json()["detail"]
        locations = [e["loc"] for e in errors]
        assert any("name" in loc for loc in locations)


class TestUpdateClient:
    def test_put_updates_fields_and_returns_200(self, client: TestClient) -> None:
        """PUT /business/clients/{id} replaces all fields and returns 200."""
        payload = {
            "name": "Sulpetro Updated",
            "email": "new@sulpetro.com",
            "phone": "(403) 000-0000",
            "city": "Edmonton",
            "state": "Alberta",
            "country": "Canada",
            "hourly_rate": "120.00",
            "timesheet_frequency": "monthly",
            "is_active": True,
        }
        response = client.put(f"/business/clients/{SEED_ID_1}", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Sulpetro Updated"
        assert data["email"] == "new@sulpetro.com"
        assert data["city"] == "Edmonton"

    def test_put_preserves_created_at_and_bumps_updated_at(
        self, client: TestClient
    ) -> None:
        """PUT preserves created_at and sets updated_at to a newer value."""
        # Get original timestamps
        original = client.get(f"/business/clients/{SEED_ID_1}").json()
        original_created = original["created_at"]
        original_updated = original["updated_at"]

        payload = {
            "name": "Sulpetro Modified",
            "country": "Canada",
            "timesheet_frequency": "monthly",
            "is_active": True,
        }
        response = client.put(f"/business/clients/{SEED_ID_1}", json=payload)
        data = response.json()

        assert data["created_at"] == original_created
        assert data["updated_at"] != original_updated

    def test_put_can_toggle_is_active_to_false(self, client: TestClient) -> None:
        """PUT with is_active=False archives the client."""
        payload = {
            "name": "Sulpetro",
            "country": "Canada",
            "timesheet_frequency": "monthly",
            "is_active": False,
        }
        response = client.put(f"/business/clients/{SEED_ID_1}", json=payload)
        assert response.status_code == 200
        assert response.json()["is_active"] is False

        # Confirm archived client appears in include_archived=true but not default list
        default_ids = [
            c["id"] for c in client.get("/business/clients/").json()
        ]
        assert SEED_ID_1 not in default_ids

        archived_ids = [
            c["id"]
            for c in client.get(
                "/business/clients/?include_archived=true"
            ).json()
        ]
        assert SEED_ID_1 in archived_ids

    def test_put_returns_404_for_unknown_uuid(self, client: TestClient) -> None:
        """PUT /business/clients/{random-uuid} returns 404."""
        payload = {
            "name": "Ghost Client",
            "country": "Canada",
            "timesheet_frequency": "monthly",
        }
        response = client.put(f"/business/clients/{RANDOM_UUID}", json=payload)
        assert response.status_code == 404


class TestHealthCheck:
    def test_health_returns_200_ok(self, client: TestClient) -> None:
        """GET /health returns 200 with {\"status\": \"ok\"}."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
