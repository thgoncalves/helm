"""Pydantic models for the ``personal_imports`` table."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.models.personal_accounts import Institution


class PersonalImportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_id: UUID
    institution: Institution
    status: str
    s3_key: str
    filename: str | None = None
    size_bytes: int | None = None
    row_count: int | None = None
    imported_count: int | None = None
    skipped_count: int | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class PersonalImportCreateRequest(BaseModel):
    """``POST /personal/imports/`` body.

    The client picks which account this CSV belongs to and which
    parser to use. We sign a presigned PUT for the file body and
    return both the new row + the upload URL.
    """

    account_id: UUID
    institution: Institution
    filename: str | None = None
    size_bytes: int | None = None


class PersonalImportCreateResponse(BaseModel):
    import_: PersonalImportRead
    upload_url: str

    model_config = ConfigDict(populate_by_name=True)
