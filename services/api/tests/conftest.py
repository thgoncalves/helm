"""pytest configuration and shared fixtures."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
import app.routers.clients as clients_module


@pytest.fixture(autouse=True)
def reset_clients_store() -> None:
    """Reset the in-memory clients store to its seed state before each test.

    This prevents state from leaking between tests when the module-level
    ``_CLIENTS`` dict is mutated by create/update operations.

    Yields:
        None — this is a setup-only fixture.
    """
    clients_module._CLIENTS = clients_module._build_seed_store()
    yield


@pytest.fixture
def client() -> TestClient:
    """Return a synchronous FastAPI test client.

    Returns:
        A :class:`fastapi.testclient.TestClient` wrapping the Helm API app.
    """
    return TestClient(app)
