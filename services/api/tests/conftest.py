"""pytest configuration and shared fixtures."""

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    """Return a synchronous FastAPI test client.

    Returns:
        A :class:`fastapi.testclient.TestClient` wrapping the Helm API app.
    """
    return TestClient(app)
