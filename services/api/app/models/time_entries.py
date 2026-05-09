"""Pydantic models for the ``time_entries`` table.

Mirrors the Drizzle schema in ``db/schema/time-entries.ts``.

Note: the legacy CSV ``description`` column was dropped in V1 per spec.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class TimeEntryBase(BaseModel):
    """Shared data fields for a time entry (no id or timestamps).

    Attributes:
        client_id: UUID of the client this time was logged against.
        work_date: Calendar date the work was performed.
        hours: Number of hours worked (e.g. ``7.50``).
        invoice_id: UUID of the invoice this entry was included on.
            ``None`` if not yet invoiced. Set to ``NULL`` on invoice deletion
            (ON DELETE SET NULL).
    """

    client_id: UUID
    work_date: date
    hours: Decimal
    invoice_id: UUID | None = None


class TimeEntryCreate(TimeEntryBase):
    """Request body for logging a new time entry.

    Inherits all fields from :class:`TimeEntryBase`.
    """


class TimeEntryRead(TimeEntryBase):
    """Response model for reading a time entry.

    Extends :class:`TimeEntryBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class TimeEntryUpdate(BaseModel):
    """Request body for partially updating a time entry (PATCH).

    All fields are optional so the caller only sends what changed.
    """

    client_id: UUID | None = None
    work_date: date | None = None
    hours: Decimal | None = None
    invoice_id: UUID | None = None
