"""Unit test for the :func:`app.db.execute_many` batch helper.

The helper is hot-path code in the YNAB sync — keep a small,
self-contained test so a regression here can't quietly slow the
endpoint back past the API Gateway 30s integration timeout.
"""

from __future__ import annotations

from typing import Any

import pytest

from app import db as db_module


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def batch_execute_statement(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {}


@pytest.fixture
def recording_client(monkeypatch: pytest.MonkeyPatch) -> _RecordingClient:
    c = _RecordingClient()
    monkeypatch.setattr(db_module, "_RDS_CLIENT", c)
    monkeypatch.setattr(
        db_module.settings, "database_resource_arn", "arn:test:cluster"
    )
    monkeypatch.setattr(
        db_module.settings, "database_secret_arn", "arn:test:secret"
    )
    monkeypatch.setattr(db_module.settings, "database_name", "helm")
    return c


def test_empty_param_sets_skips_aws_call(
    recording_client: _RecordingClient,
) -> None:
    db_module.execute_many("INSERT INTO t (id) VALUES (:id)", [])
    assert recording_client.calls == []


def test_single_chunk_sends_one_request(
    recording_client: _RecordingClient,
) -> None:
    db_module.execute_many(
        "INSERT INTO t (id) VALUES (:id)",
        [{"id": i} for i in range(10)],
    )
    assert len(recording_client.calls) == 1
    call = recording_client.calls[0]
    assert call["sql"] == "INSERT INTO t (id) VALUES (:id)"
    assert len(call["parameterSets"]) == 10


def test_large_input_chunks_into_multiple_requests(
    recording_client: _RecordingClient,
) -> None:
    # _BATCH_CHUNK_SIZE = 250 → 600 rows = 3 batches (250 + 250 + 100).
    db_module.execute_many(
        "INSERT INTO t (id) VALUES (:id)",
        [{"id": i} for i in range(600)],
    )
    assert len(recording_client.calls) == 3
    sizes = [len(c["parameterSets"]) for c in recording_client.calls]
    assert sizes == [250, 250, 100]
