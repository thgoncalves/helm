"""FastAPI router for the /business/clients endpoints.

Data is currently in-memory (module-scoped dict). When the DB layer is added,
the in-memory store will be replaced with RDS Data API calls via boto3.

.. warning::
    The in-memory store loses all data on Lambda cold start and does not
    persist across Lambda instances. This is intentional for the current
    iteration; DB integration is a follow-up task.
"""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app.deps import get_current_user
from app.models.clients import ClientCreate, ClientRead

router = APIRouter(tags=["clients"], dependencies=[Depends(get_current_user)])

# ---------------------------------------------------------------------------
# Deterministic seed UUIDs so tests can reference them by value.
# ---------------------------------------------------------------------------

_SEED_ID_1 = UUID("00000000-0000-0000-0000-000000000001")
_SEED_ID_2 = UUID("00000000-0000-0000-0000-000000000002")
_SEED_ID_3 = UUID("00000000-0000-0000-0000-000000000003")

# ---------------------------------------------------------------------------
# In-memory store — dict keyed by UUID, module-scoped so it persists across
# requests within the same Lambda instance / test session.
# ---------------------------------------------------------------------------


def _build_seed_store() -> dict[UUID, ClientRead]:
    """Build the initial seeded client dictionary.

    Returns:
        A dict mapping UUID → ClientRead for the three seed clients derived
        from the legacy data: Sulpetro, Wenco, Nutrien.
    """
    seed_time = datetime(2022, 3, 1, 9, 0, 0, tzinfo=timezone.utc)
    return {
        _SEED_ID_1: ClientRead(
            id=_SEED_ID_1,
            name="Sulpetro",
            email="ckingsford@sulpetro.com",
            phone="(403) 619-7785",
            address_line1=None,
            address_line2=None,
            city="Calgary",
            state="Alberta",
            postal_code=None,
            country="Canada",
            tax_id=None,
            notes=None,
            is_active=True,
            hourly_rate=Decimal("100.00"),
            timesheet_frequency="monthly",
            created_at=seed_time,
            updated_at=seed_time,
        ),
        _SEED_ID_2: ClientRead(
            id=_SEED_ID_2,
            name="Wenco",
            email=None,
            phone=None,
            address_line1=None,
            address_line2=None,
            city=None,
            state=None,
            postal_code=None,
            country="Canada",
            tax_id=None,
            notes=None,
            is_active=True,
            hourly_rate=Decimal("95.38"),
            timesheet_frequency="monthly",
            created_at=seed_time,
            updated_at=seed_time,
        ),
        _SEED_ID_3: ClientRead(
            id=_SEED_ID_3,
            name="Nutrien",
            email=None,
            phone=None,
            address_line1=None,
            address_line2=None,
            city=None,
            state=None,
            postal_code=None,
            country="Canada",
            tax_id=None,
            notes=None,
            is_active=False,
            hourly_rate=None,
            timesheet_frequency="monthly",
            created_at=seed_time,
            updated_at=seed_time,
        ),
    }


_CLIENTS: dict[UUID, ClientRead] = _build_seed_store()


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
        A list of :class:`~app.models.clients.ClientRead` objects.
    """
    clients = list(_CLIENTS.values())
    if not include_archived:
        clients = [c for c in clients if c.is_active]
    return clients


@router.get("/{client_id}", response_model=ClientRead, summary="Get a client")
async def get_client(client_id: UUID) -> ClientRead:
    """Return a single client by ID.

    Args:
        client_id: UUID primary key of the client.

    Returns:
        The matching :class:`~app.models.clients.ClientRead`.

    Raises:
        HTTPException: 404 if no client with ``client_id`` exists.
    """
    client = _CLIENTS.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return client


@router.post(
    "/",
    response_model=ClientRead,
    status_code=201,
    summary="Create a new client",
)
async def create_client(body: ClientCreate) -> ClientRead:
    """Create a new client.

    Generates a fresh UUID and sets ``created_at`` / ``updated_at`` to the
    current UTC time. ``is_active`` defaults to ``True`` (from the model).

    Args:
        body: The client data to create.

    Returns:
        The newly created :class:`~app.models.clients.ClientRead`, including
        server-assigned ``id``, ``created_at``, and ``updated_at``.
    """
    now = datetime.now(timezone.utc)
    new_id = uuid4()
    client = ClientRead(
        id=new_id,
        created_at=now,
        updated_at=now,
        **body.model_dump(),
    )
    _CLIENTS[new_id] = client
    return client


@router.put(
    "/{client_id}",
    response_model=ClientRead,
    summary="Replace a client (full update)",
)
async def update_client(client_id: UUID, body: ClientCreate) -> ClientRead:
    """Replace all editable fields on a client (full PUT).

    Preserves the original ``created_at``. Sets ``updated_at`` to the current
    UTC time. Accepts ``is_active`` through :class:`~app.models.clients.ClientCreate`
    (it is an optional field defaulting to ``True``) so the Edit form can
    toggle archive/active status.

    Args:
        client_id: UUID primary key of the client to update.
        body: The replacement data. All fields except ``id`` and ``created_at``
            are replaced.

    Returns:
        The updated :class:`~app.models.clients.ClientRead`.

    Raises:
        HTTPException: 404 if no client with ``client_id`` exists.
    """
    existing = _CLIENTS.get(client_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Client not found")

    now = datetime.now(timezone.utc)
    updated = ClientRead(
        id=client_id,
        created_at=existing.created_at,
        updated_at=now,
        **body.model_dump(),
    )
    _CLIENTS[client_id] = updated
    return updated
