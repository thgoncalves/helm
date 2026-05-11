"""Cached boto3 clients for non-Aurora AWS services.

The RDS Data API client lives in ``app.db``. This module hosts the
other boto3 clients (S3 for presigned URLs + receipt uploads, Textract
for the expense processor handler).

Tests substitute ``_S3_CLIENT`` / ``_TEXTRACT_CLIENT`` directly via
``monkeypatch.setattr`` to inject fakes.
"""

from __future__ import annotations

from typing import Any

import boto3

_S3_CLIENT: Any = None
_TEXTRACT_CLIENT: Any = None


def s3() -> Any:
    """Return the process-cached boto3 ``s3`` client."""
    global _S3_CLIENT
    if _S3_CLIENT is None:
        _S3_CLIENT = boto3.client("s3")
    return _S3_CLIENT


def textract() -> Any:
    """Return the process-cached boto3 ``textract`` client."""
    global _TEXTRACT_CLIENT
    if _TEXTRACT_CLIENT is None:
        _TEXTRACT_CLIENT = boto3.client("textract")
    return _TEXTRACT_CLIENT
