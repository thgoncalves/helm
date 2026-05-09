"""Pydantic models for the ``clients`` table.

Mirrors the Drizzle schema in ``db/schema/clients.ts``.
"""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ClientBase(BaseModel):
    """Shared data fields for a client (no id or timestamps).

    Attributes:
        name: Display name of the client. Required.
        email: Contact email address. Optional.
        phone: Contact phone number. Optional.
        address_line1: First line of billing address. Optional.
        address_line2: Second line of billing address. Optional.
        city: City for billing address. Optional.
        state: State/province for billing address. Optional.
        postal_code: Postal or ZIP code. Optional.
        country: Country for billing address. Optional.
        tax_id: Business tax/GST number. Optional.
        notes: Free-form notes about the client. Optional.
        is_active: Whether the client is active. Defaults to ``True``.
        hourly_rate: Default billing rate in the client's currency. Optional.
        timesheet_frequency: How often timesheets are submitted.
            Defaults to ``"monthly"``.
        contract_value: Total monetary value of the active contract (used to
            compute remaining $/hours on the timesheet page). Optional.
        contract_currency: ISO currency code for ``contract_value``.
            Defaults to ``"CAD"``.
        default_task_description: Default line-item text printed on every
            populated row of the exported PDF timesheet. Optional.
    """

    name: str
    email: str | None = None
    phone: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    is_active: bool = True
    hourly_rate: Decimal | None = None
    timesheet_frequency: str | None = "monthly"
    contract_value: Decimal | None = None
    contract_currency: str | None = "CAD"
    default_task_description: str | None = None


class ClientCreate(ClientBase):
    """Request body for creating a new client (POST /business/clients).

    Inherits all fields from :class:`ClientBase`.
    """


class ClientRead(ClientBase):
    """Response model for reading a client.

    Extends :class:`ClientBase` with server-generated fields.

    Attributes:
        id: Primary key UUID.
        created_at: Timestamp when the record was created (UTC).
        updated_at: Timestamp when the record was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime
    updated_at: datetime


class ClientUpdate(BaseModel):
    """Request body for partially updating a client (PATCH /business/clients/{id}).

    All fields are optional so the caller only sends what changed.
    """

    name: str | None = None
    email: str | None = None
    phone: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    postal_code: str | None = None
    country: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    is_active: bool | None = None
    hourly_rate: Decimal | None = None
    timesheet_frequency: str | None = None
    contract_value: Decimal | None = None
    contract_currency: str | None = None
    default_task_description: str | None = None
