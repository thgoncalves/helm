"""Integration tests for the /business/clients router.

Uses FastAPI's synchronous TestClient (via httpx under the hood).
"""

import uuid

import pytest
from fastapi.testclient import TestClient


class TestListClients:
    def test_returns_200_and_list_of_two(self, client: TestClient) -> None:
        """GET /business/clients returns 200 with two stubbed clients."""
        response = client.get("/business/clients/")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2

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
        # timestamps should be present
        assert "created_at" in data
        assert "updated_at" in data
        assert data["created_at"] is not None
        assert data["updated_at"] is not None

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


class TestHealthCheck:
    def test_health_returns_200_ok(self, client: TestClient) -> None:
        """GET /health returns 200 with {\"status\": \"ok\"}."""
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
