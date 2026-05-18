"""RDS Data API wrapper for Aurora Serverless v2 Postgres.

Provides ``execute`` / ``fetch_all`` / ``fetch_one`` helpers so routers don't
have to deal with the Data API's parameter coercion, column-metadata parsing,
or Aurora's auto-pause warm-up.

All functions are synchronous: in Lambda there's one request per container
at a time, and FastAPI runs ``async def`` handlers cooperatively, so the
blocking ``boto3`` call is acceptable here. If concurrency ever matters
locally, wrap calls in ``asyncio.to_thread``.

Tests should monkey-patch this module's ``_RDS_CLIENT`` attribute to inject
a stub instead of going through a real boto3 client.
"""

from __future__ import annotations

import time
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

import boto3
from botocore.exceptions import ClientError
from fastapi import HTTPException

from app.config import settings

# Boto3 error codes that mean "your AWS credentials are bad" — we map
# these to a 503 with a friendly message so the response goes through
# the CORS middleware. Without this, FastAPI returns an undecorated 500
# and the browser surfaces it as "Failed to fetch" because the CORS
# headers are missing on the unhandled error.
_AWS_AUTH_ERROR_CODES = frozenset(
    {
        "UnrecognizedClientException",
        "ExpiredTokenException",
        "InvalidSignatureException",
        "InvalidClientTokenId",
        "AccessDeniedException",
        "SignatureDoesNotMatch",
    }
)

# ---------------------------------------------------------------------------
# Cached boto3 client
# ---------------------------------------------------------------------------

_RDS_CLIENT: Any = None


def _client() -> Any:
    """Return the process-cached boto3 ``rds-data`` client.

    Tests substitute the cached client by setting ``app.db._RDS_CLIENT``
    directly (e.g. via ``monkeypatch.setattr``).
    """
    global _RDS_CLIENT
    if _RDS_CLIENT is None:
        _RDS_CLIENT = boto3.client("rds-data")
    return _RDS_CLIENT


# ---------------------------------------------------------------------------
# Python → Data API parameter coercion
# ---------------------------------------------------------------------------


def _to_param(name: str, value: Any) -> dict[str, Any]:
    """Convert a (name, Python value) pair to a Data API parameter dict."""
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    # bool must be checked before int (isinstance(True, int) is True)
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, float):
        return {"name": name, "value": {"doubleValue": value}}
    if isinstance(value, UUID):
        return {
            "name": name,
            "value": {"stringValue": str(value)},
            "typeHint": "UUID",
        }
    if isinstance(value, Decimal):
        return {
            "name": name,
            "value": {"stringValue": str(value)},
            "typeHint": "DECIMAL",
        }
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return {
            "name": name,
            "value": {
                "stringValue": value.isoformat(sep=" ", timespec="milliseconds")
            },
            "typeHint": "TIMESTAMP",
        }
    if isinstance(value, date):
        return {
            "name": name,
            "value": {"stringValue": value.isoformat()},
            "typeHint": "DATE",
        }
    if isinstance(value, str):
        return {"name": name, "value": {"stringValue": value}}
    raise TypeError(
        f"Unsupported Data API parameter type for {name!r}: "
        f"{type(value).__name__}"
    )


def _to_params(values: dict[str, Any]) -> list[dict[str, Any]]:
    return [_to_param(name, value) for name, value in values.items()]


# ---------------------------------------------------------------------------
# Data API record → Python dict
# ---------------------------------------------------------------------------


def _from_value(field: dict[str, Any], type_name: str) -> Any:
    """Convert a single Data API field value back to a Python type.

    ``type_name`` is the Postgres type name from ``columnMetadata.typeName``
    (e.g. ``"uuid"``, ``"numeric"``, ``"timestamptz"``).
    """
    if field.get("isNull"):
        return None
    if "booleanValue" in field:
        return field["booleanValue"]
    if "longValue" in field:
        return field["longValue"]
    if "doubleValue" in field:
        return field["doubleValue"]
    if "stringValue" in field:
        s: str = field["stringValue"]
        if type_name == "uuid":
            return UUID(s)
        if type_name == "numeric":
            return Decimal(s)
        if type_name in ("timestamp", "timestamptz"):
            # Data API returns 'YYYY-MM-DD HH:MM:SS[.fff]' with no offset;
            # timestamptz values are already normalised to UTC.
            dt = datetime.fromisoformat(s)
            if type_name == "timestamptz" and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        if type_name == "date":
            return date.fromisoformat(s)
        return s
    raise ValueError(f"Unrecognised Data API field shape: {field!r}")


def _records_to_dicts(
    records: list[list[dict[str, Any]]],
    column_metadata: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    columns = [(c["name"], c["typeName"]) for c in column_metadata]
    return [
        {
            name: _from_value(field, type_name)
            for (name, type_name), field in zip(columns, record)
        }
        for record in records
    ]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def execute(sql: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute a non-SELECT statement (INSERT/UPDATE/DELETE/DDL).

    Returns the raw Data API response. Use this when you don't need rows
    back (e.g. ``DELETE FROM ...``). For statements with a ``RETURNING``
    clause, prefer :func:`fetch_one` or :func:`fetch_all`.
    """
    return _execute(sql, params, include_metadata=False)


def fetch_all(
    sql: str, params: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Execute a SELECT (or RETURNING) and return all rows as dicts."""
    response = _execute(sql, params, include_metadata=True)
    return _records_to_dicts(
        response.get("records", []),
        response.get("columnMetadata", []),
    )


def fetch_one(
    sql: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Execute a SELECT (or RETURNING) and return the first row, or None."""
    rows = fetch_all(sql, params)
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Inner: execute with auto-resume retry
# ---------------------------------------------------------------------------

_RESUME_MAX_WAIT_SEC = 30.0
_RESUME_INITIAL_DELAY_SEC = 1.0
_RESUME_MAX_DELAY_SEC = 5.0


def _execute(
    sql: str,
    params: dict[str, Any] | None,
    *,
    include_metadata: bool,
) -> dict[str, Any]:
    if not settings.database_resource_arn or not settings.database_secret_arn:
        raise RuntimeError(
            "HELM_DATABASE_RESOURCE_ARN and HELM_DATABASE_SECRET_ARN must be "
            "set to use the database. Currently unset — check your .env or "
            "Lambda environment."
        )

    kwargs: dict[str, Any] = {
        "resourceArn": settings.database_resource_arn,
        "secretArn": settings.database_secret_arn,
        "database": settings.database_name,
        "sql": sql,
        "includeResultMetadata": include_metadata,
    }
    if params:
        kwargs["parameters"] = _to_params(params)

    delay = _RESUME_INITIAL_DELAY_SEC
    deadline = time.monotonic() + _RESUME_MAX_WAIT_SEC
    while True:
        try:
            return _client().execute_statement(**kwargs)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "DatabaseResumingException" and time.monotonic() < deadline:
                time.sleep(delay)
                delay = min(delay * 2, _RESUME_MAX_DELAY_SEC)
                continue
            if code in _AWS_AUTH_ERROR_CODES:
                raise HTTPException(
                    status_code=503,
                    detail={
                        "code": "AWS_AUTH",
                        "message": (
                            "Local AWS credentials are expired or invalid; "
                            "refresh them (e.g. `aws sso login`) and retry."
                        ),
                        "aws_code": code,
                    },
                ) from e
            raise
