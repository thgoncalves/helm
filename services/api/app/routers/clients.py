"""FastAPI router for the /business/clients endpoints.

Data is currently in-memory (stubbed). When the DB layer is added, the
in-memory list will be replaced with RDS Data API calls via boto3.
"""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends

from app.deps import get_current_user
from app.models.clients import ClientCreate, ClientRead

router = APIRouter(tags=["clients"], dependencies=[Depends(get_current_user)])

# ---------------------------------------------------------------------------
# In-memory stub data — replaced by DB queries in a later iteration.
# ---------------------------------------------------------------------------

_CLIENTS: list[ClientRead] = [
    ClientRead(
        id=UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
        name="Acme Corp",
        email="billing@acme.example.com",
        phone="+1-416-555-0100",
        address_line1="100 King Street West",
        address_line2="Suite 5400",
        city="Toronto",
        state="ON",
        postal_code="M5X 1C9",
        country="Canada",
        tax_id="123456789RT0001",
        notes="Primary Canadian client. Net 30 terms.",
        is_active=True,
        hourly_rate=Decimal("185.00"),
        timesheet_frequency="monthly",
        created_at=datetime(2022, 3, 1, 9, 0, 0, tzinfo=timezone.utc),
        updated_at=datetime(2024, 11, 15, 14, 30, 0, tzinfo=timezone.utc),
    ),
    ClientRead(
        id=UUID("b2c3d4e5-f6a7-8901-bcde-f12345678901"),
        name="Bluestone Digital",
        email="accounts@bluestone.example.com",
        phone="+1-604-555-0200",
        address_line1="555 West Hastings Street",
        city="Vancouver",
        state="BC",
        postal_code="V6B 4N6",
        country="Canada",
        tax_id=None,
        notes="BC-based startup. Invoiced bi-monthly.",
        is_active=True,
        hourly_rate=Decimal("175.00"),
        timesheet_frequency="monthly",
        created_at=datetime(2023, 6, 15, 10, 0, 0, tzinfo=timezone.utc),
        updated_at=datetime(2025, 1, 10, 8, 45, 0, tzinfo=timezone.utc),
    ),
]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/", response_model=list[ClientRead], summary="List all clients")
async def list_clients() -> list[ClientRead]:
    """Return all clients.

    Returns:
        A list of all clients in the system.
    """
    return _CLIENTS


@router.post(
    "/",
    response_model=ClientRead,
    status_code=201,
    summary="Create a new client",
)
async def create_client(body: ClientCreate) -> ClientRead:
    """Create a new client.

    Args:
        body: The client data to create.

    Returns:
        The newly created client, including server-assigned ``id``,
        ``created_at``, and ``updated_at``.
    """
    now = datetime.now(timezone.utc)
    client = ClientRead(
        id=uuid4(),
        created_at=now,
        updated_at=now,
        **body.model_dump(),
    )
    _CLIENTS.append(client)
    return client
