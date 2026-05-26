"""Pydantic models for user-defined account categories ("buckets").

Internally we call them buckets because YNAB already owns the word
"category" in this codebase (budget categories). The UI calls them
Categories.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class AccountBucketRead(BaseModel):
    """One category as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    color: str | None = None
    sort_order: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AccountBucketCreate(BaseModel):
    """Body for ``POST /accounts/buckets``."""

    name: str = Field(min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=24)


class AccountBucketUpdate(BaseModel):
    """Body for ``PATCH /accounts/buckets/{id}``. All fields optional."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=24)
    sort_order: int | None = None


class AccountPlacementUpdate(BaseModel):
    """Body for ``PATCH /accounts/{source}/{id}/placement``.

    ``bucket_id = None`` means "move to Uncategorized". ``sort_index``
    is the new position within the destination bucket (0-indexed); the
    server writes it as-is, no re-balancing.
    """

    bucket_id: UUID | None = None
    sort_index: int = 0
