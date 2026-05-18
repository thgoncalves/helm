"""Cached boto3 clients for non-Aurora AWS services.

The RDS Data API client lives in ``app.db``. This module hosts the
other boto3 clients (S3 for presigned URLs + receipt uploads, Textract
for the expense processor handler).

Tests substitute ``_S3_CLIENT`` / ``_TEXTRACT_CLIENT`` directly via
``monkeypatch.setattr`` to inject fakes.
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from botocore.config import Config

_S3_CLIENT: Any = None
_TEXTRACT_CLIENT: Any = None
_SECRETS_CLIENT: Any = None


def s3() -> Any:
    """Return the process-cached boto3 ``s3`` client.

    Pinned to the Lambda's region with virtual-hosted addressing so
    presigned URLs target ``<bucket>.s3.<region>.amazonaws.com``. Without
    this, boto3 defaults to the regionless ``s3.amazonaws.com`` host for
    DNS-safe bucket names; S3 answers the PUT with a 307 to the regional
    endpoint, and browsers refuse to replay the body across hosts — the
    fetch throws ``TypeError: Load failed`` with no helpful error.
    """
    global _S3_CLIENT
    if _S3_CLIENT is None:
        region = os.environ.get("AWS_REGION") or "ca-central-1"
        _S3_CLIENT = boto3.client(
            "s3",
            region_name=region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
            ),
        )
    return _S3_CLIENT


def textract() -> Any:
    """Return the process-cached boto3 ``textract`` client."""
    global _TEXTRACT_CLIENT
    if _TEXTRACT_CLIENT is None:
        _TEXTRACT_CLIENT = boto3.client("textract")
    return _TEXTRACT_CLIENT


def secretsmanager() -> Any:
    """Return the process-cached boto3 ``secretsmanager`` client.

    Used by the Money module to read/write the YNAB Personal Access
    Token. Tests substitute ``_SECRETS_CLIENT`` directly.
    """
    global _SECRETS_CLIENT
    if _SECRETS_CLIENT is None:
        region = os.environ.get("AWS_REGION") or "ca-central-1"
        _SECRETS_CLIENT = boto3.client("secretsmanager", region_name=region)
    return _SECRETS_CLIENT
