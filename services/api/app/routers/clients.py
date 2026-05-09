"""FastAPI router for the ``/business/clients`` endpoints.

All persistence goes through :mod:`app.db` (RDS Data API → Aurora). The
seed clients live in the database, populated by ``scripts/import_legacy.py``
from ``old_database/clients.csv``.
"""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.deps import get_current_user
from app.models.clients import ClientCreate, ClientRead

router = APIRouter(tags=["clients"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/", response_model=list[ClientRead], summary="List clients")
async def list_clients(
    include_archived: bool = Query(
        default=False,
        description="When true, return all clients including archived (is_active=False).",
    ),
) -> list[ClientRead]:
    """Return clients, optionally including archived ones.

    Args:
        include_archived: If ``False`` (default), only active clients are
            returned. If ``True``, all clients (active and archived) are
            returned.

    Returns:
        A list of :class:`~app.models.clients.ClientRead` objects, sorted
        by name.
    """
    if include_archived:
        rows = db.fetch_all("SELECT * FROM clients ORDER BY name")
    else:
        rows = db.fetch_all(
            "SELECT * FROM clients WHERE is_active = TRUE ORDER BY name"
        )
    return [ClientRead(**row) for row in rows]


@router.get("/{client_id}", response_model=ClientRead, summary="Get a client")
async def get_client(client_id: UUID) -> ClientRead:
    """Return a single client by ID.

    Raises:
        HTTPException: 404 if no client with ``client_id`` exists.
    """
    row = db.fetch_one(
        "SELECT * FROM clients WHERE id = :id",
        {"id": client_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return ClientRead(**row)


@router.post(
    "/",
    response_model=ClientRead,
    status_code=201,
    summary="Create a new client",
)
async def create_client(body: ClientCreate) -> ClientRead:
    """Create a new client.

    Generates a fresh UUID and sets ``created_at`` / ``updated_at`` to the
    current UTC time.
    """
    now = datetime.now(timezone.utc)
    params = body.model_dump()
    params["id"] = uuid4()
    params["created_at"] = now
    params["updated_at"] = now

    row = db.fetch_one(
        """
        INSERT INTO clients (
            id, name, email, phone, address_line1, address_line2,
            city, state, postal_code, country, tax_id, notes,
            is_active, hourly_rate, timesheet_frequency,
            contract_value, contract_currency, default_task_description,
            created_at, updated_at
        ) VALUES (
            :id, :name, :email, :phone, :address_line1, :address_line2,
            :city, :state, :postal_code, :country, :tax_id, :notes,
            :is_active, :hourly_rate, :timesheet_frequency,
            :contract_value, :contract_currency, :default_task_description,
            :created_at, :updated_at
        )
        RETURNING *
        """,
        params,
    )
    assert row is not None  # INSERT ... RETURNING always yields one row
    return ClientRead(**row)


@router.put(
    "/{client_id}",
    response_model=ClientRead,
    summary="Replace a client (full update)",
)
async def update_client(client_id: UUID, body: ClientCreate) -> ClientRead:
    """Replace all editable fields on a client.

    Preserves the original ``created_at``; sets ``updated_at`` to the
    current UTC time. ``is_active`` may be toggled here so the Edit form
    can archive/unarchive.

    Raises:
        HTTPException: 404 if no client with ``client_id`` exists.
    """
    params = body.model_dump()
    params["id"] = client_id
    params["updated_at"] = datetime.now(timezone.utc)

    row = db.fetch_one(
        """
        UPDATE clients SET
            name = :name,
            email = :email,
            phone = :phone,
            address_line1 = :address_line1,
            address_line2 = :address_line2,
            city = :city,
            state = :state,
            postal_code = :postal_code,
            country = :country,
            tax_id = :tax_id,
            notes = :notes,
            is_active = :is_active,
            hourly_rate = :hourly_rate,
            timesheet_frequency = :timesheet_frequency,
            contract_value = :contract_value,
            contract_currency = :contract_currency,
            default_task_description = :default_task_description,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        params,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return ClientRead(**row)
