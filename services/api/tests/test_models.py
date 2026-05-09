"""Unit tests for Pydantic models.

Covers clients, invoices, invoice_line_items, and time_entries.
Tests: happy path parsing, missing required fields, invalid UUIDs,
Decimal precision, and Update model accepting an empty dict.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.models.clients import ClientCreate, ClientRead, ClientUpdate
from app.models.invoice_line_items import (
    InvoiceLineItemCreate,
    InvoiceLineItemRead,
    InvoiceLineItemUpdate,
)
from app.models.invoices import InvoiceCreate, InvoiceRead, InvoiceUpdate
from app.models.time_entries import TimeEntryCreate, TimeEntryRead, TimeEntryUpdate

# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

CLIENT_ID = UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
INVOICE_ID = UUID("b2c3d4e5-f6a7-8901-bcde-f12345678901")
LINE_ITEM_ID = UUID("c3d4e5f6-a7b8-9012-cdef-012345678902")
TIME_ENTRY_ID = UUID("d4e5f6a7-b8c9-0123-def0-123456789003")
NOW = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
TODAY = date(2025, 1, 15)


# ---------------------------------------------------------------------------
# Client model tests
# ---------------------------------------------------------------------------


class TestClientCreate:
    def test_happy_path(self) -> None:
        """Valid input parses correctly into ClientCreate."""
        client = ClientCreate(
            name="Acme Corp",
            email="billing@acme.example.com",
            hourly_rate=Decimal("185.00"),
        )
        assert client.name == "Acme Corp"
        assert client.email == "billing@acme.example.com"
        assert client.hourly_rate == Decimal("185.00")
        assert client.is_active is True  # default

    def test_missing_required_name_raises(self) -> None:
        """Missing 'name' field raises ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            ClientCreate()  # type: ignore[call-arg]
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("name",) for e in errors)

    def test_optional_fields_default_to_none(self) -> None:
        """Optional fields default to None when not provided."""
        client = ClientCreate(name="Solo Client")
        assert client.email is None
        assert client.phone is None
        assert client.hourly_rate is None
        assert client.notes is None


class TestClientRead:
    def test_happy_path(self) -> None:
        """Full valid input parses into ClientRead."""
        client = ClientRead(
            id=CLIENT_ID,
            name="Acme Corp",
            hourly_rate=Decimal("185.00"),
            created_at=NOW,
            updated_at=NOW,
        )
        assert client.id == CLIENT_ID
        assert client.hourly_rate == Decimal("185.00")
        assert client.created_at == NOW

    def test_invalid_uuid_raises(self) -> None:
        """Invalid UUID string raises ValidationError."""
        with pytest.raises(ValidationError):
            ClientRead(
                id="not-a-uuid",  # type: ignore[arg-type]
                name="Bad Client",
                created_at=NOW,
                updated_at=NOW,
            )

    def test_decimal_precision_preserved(self) -> None:
        """Decimal precision is preserved through parse and round-trip."""
        rate = Decimal("185.75")
        client = ClientRead(
            id=CLIENT_ID,
            name="Precision Test",
            hourly_rate=rate,
            created_at=NOW,
            updated_at=NOW,
        )
        # Round-trip via model_dump
        dumped = client.model_dump()
        assert dumped["hourly_rate"] == rate


class TestClientUpdate:
    def test_empty_dict_accepted(self) -> None:
        """ClientUpdate accepts an empty dict (all fields optional)."""
        update = ClientUpdate()
        assert update.name is None
        assert update.email is None
        assert update.is_active is None

    def test_partial_update(self) -> None:
        """ClientUpdate accepts a subset of fields."""
        update = ClientUpdate(name="New Name", is_active=False)
        assert update.name == "New Name"
        assert update.is_active is False
        assert update.email is None


# ---------------------------------------------------------------------------
# Invoice model tests
# ---------------------------------------------------------------------------


class TestInvoiceCreate:
    def test_happy_path(self) -> None:
        """Valid input parses correctly into InvoiceCreate."""
        invoice = InvoiceCreate(
            invoice_number="202501-001",
            issue_date=TODAY,
            client_id=CLIENT_ID,
            subtotal=Decimal("1000.00"),
            total=Decimal("1050.00"),
            tax_amount=Decimal("50.00"),
        )
        assert invoice.invoice_number == "202501-001"
        assert invoice.status == "draft"  # default
        assert invoice.currency == "CAD"  # default

    def test_missing_required_fields_raises(self) -> None:
        """Missing required fields raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            InvoiceCreate(invoice_number="202501-001")  # type: ignore[call-arg]
        errors = exc_info.value.errors()
        field_names = {e["loc"][0] for e in errors}
        assert "client_id" in field_names
        assert "issue_date" in field_names
        assert "subtotal" in field_names
        assert "total" in field_names

    def test_invalid_client_id_uuid_raises(self) -> None:
        """Invalid client_id UUID raises ValidationError."""
        with pytest.raises(ValidationError):
            InvoiceCreate(
                invoice_number="202501-001",
                issue_date=TODAY,
                client_id="not-a-uuid",  # type: ignore[arg-type]
                subtotal=Decimal("1000.00"),
                total=Decimal("1000.00"),
            )

    def test_decimal_precision_preserved(self) -> None:
        """Decimal fields preserve precision through parse and round-trip."""
        subtotal = Decimal("9999.99")
        tax = Decimal("499.9995")
        total = Decimal("10499.9895")
        invoice = InvoiceCreate(
            invoice_number="202501-002",
            issue_date=TODAY,
            client_id=CLIENT_ID,
            subtotal=subtotal,
            tax_amount=tax,
            total=total,
        )
        dumped = invoice.model_dump()
        assert dumped["subtotal"] == subtotal
        assert dumped["tax_amount"] == tax
        assert dumped["total"] == total


class TestInvoiceRead:
    def test_happy_path(self) -> None:
        """Full valid input parses into InvoiceRead."""
        invoice = InvoiceRead(
            id=INVOICE_ID,
            invoice_number="202501-001",
            issue_date=TODAY,
            client_id=CLIENT_ID,
            subtotal=Decimal("1000.00"),
            total=Decimal("1050.00"),
            created_at=NOW,
            updated_at=NOW,
        )
        assert invoice.id == INVOICE_ID
        assert invoice.invoice_number == "202501-001"


class TestInvoiceUpdate:
    def test_empty_dict_accepted(self) -> None:
        """InvoiceUpdate accepts an empty dict (all fields optional)."""
        update = InvoiceUpdate()
        assert update.invoice_number is None
        assert update.status is None
        assert update.subtotal is None


# ---------------------------------------------------------------------------
# InvoiceLineItem model tests
# ---------------------------------------------------------------------------


class TestInvoiceLineItemCreate:
    def test_happy_path(self) -> None:
        """Valid input parses correctly into InvoiceLineItemCreate."""
        item = InvoiceLineItemCreate(
            invoice_id=INVOICE_ID,
            line_order=1,
            description="Senior Development – January 2025",
            quantity=Decimal("40.00"),
            unit_price=Decimal("185.00"),
            line_subtotal=Decimal("7400.00"),
            line_total=Decimal("7770.00"),
            line_tax=Decimal("370.00"),
            tax_rate=Decimal("0.0500"),
            is_taxable=True,
        )
        assert item.description == "Senior Development – January 2025"
        assert item.quantity == Decimal("40.00")
        assert item.is_taxable is True

    def test_missing_required_fields_raises(self) -> None:
        """Missing required fields raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            InvoiceLineItemCreate(invoice_id=INVOICE_ID)  # type: ignore[call-arg]
        errors = exc_info.value.errors()
        field_names = {e["loc"][0] for e in errors}
        assert "line_order" in field_names
        assert "description" in field_names
        assert "quantity" in field_names
        assert "unit_price" in field_names

    def test_invalid_invoice_id_raises(self) -> None:
        """Invalid invoice_id UUID raises ValidationError."""
        with pytest.raises(ValidationError):
            InvoiceLineItemCreate(
                invoice_id="bad-uuid",  # type: ignore[arg-type]
                line_order=1,
                description="Work",
                quantity=Decimal("1"),
                unit_price=Decimal("100"),
                line_subtotal=Decimal("100"),
                line_total=Decimal("100"),
            )

    def test_decimal_precision_preserved(self) -> None:
        """Decimal precision is preserved on line items."""
        tax_rate = Decimal("0.0500")
        item = InvoiceLineItemCreate(
            invoice_id=INVOICE_ID,
            line_order=1,
            description="Work",
            quantity=Decimal("1.00"),
            unit_price=Decimal("185.00"),
            line_subtotal=Decimal("185.00"),
            line_tax=Decimal("9.25"),
            line_total=Decimal("194.25"),
            tax_rate=tax_rate,
        )
        assert item.tax_rate == tax_rate
        dumped = item.model_dump()
        assert dumped["tax_rate"] == tax_rate


class TestInvoiceLineItemRead:
    def test_happy_path(self) -> None:
        """Full valid input parses into InvoiceLineItemRead."""
        item = InvoiceLineItemRead(
            id=LINE_ITEM_ID,
            invoice_id=INVOICE_ID,
            line_order=1,
            description="Dev work",
            quantity=Decimal("8"),
            unit_price=Decimal("185"),
            line_subtotal=Decimal("1480"),
            line_total=Decimal("1554"),
        )
        assert item.id == LINE_ITEM_ID


class TestInvoiceLineItemUpdate:
    def test_empty_dict_accepted(self) -> None:
        """InvoiceLineItemUpdate accepts an empty dict."""
        update = InvoiceLineItemUpdate()
        assert update.description is None
        assert update.quantity is None
        assert update.unit_price is None


# ---------------------------------------------------------------------------
# TimeEntry model tests
# ---------------------------------------------------------------------------


class TestTimeEntryCreate:
    def test_happy_path(self) -> None:
        """Valid input parses correctly into TimeEntryCreate."""
        entry = TimeEntryCreate(
            client_id=CLIENT_ID,
            work_date=TODAY,
            hours=Decimal("7.50"),
        )
        assert entry.client_id == CLIENT_ID
        assert entry.hours == Decimal("7.50")
        assert entry.invoice_id is None  # not yet invoiced

    def test_missing_required_fields_raises(self) -> None:
        """Missing required fields raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            TimeEntryCreate()  # type: ignore[call-arg]
        errors = exc_info.value.errors()
        field_names = {e["loc"][0] for e in errors}
        assert "client_id" in field_names
        assert "work_date" in field_names
        assert "hours" in field_names

    def test_invalid_client_id_raises(self) -> None:
        """Invalid client_id UUID raises ValidationError."""
        with pytest.raises(ValidationError):
            TimeEntryCreate(
                client_id="not-a-uuid",  # type: ignore[arg-type]
                work_date=TODAY,
                hours=Decimal("8"),
            )

    def test_decimal_hours_precision(self) -> None:
        """Hours Decimal is preserved through parse and round-trip."""
        hours = Decimal("7.75")
        entry = TimeEntryCreate(
            client_id=CLIENT_ID,
            work_date=TODAY,
            hours=hours,
        )
        assert entry.hours == hours
        assert entry.model_dump()["hours"] == hours


class TestTimeEntryRead:
    def test_happy_path(self) -> None:
        """Full valid input parses into TimeEntryRead."""
        entry = TimeEntryRead(
            id=TIME_ENTRY_ID,
            client_id=CLIENT_ID,
            work_date=TODAY,
            hours=Decimal("8"),
            created_at=NOW,
            updated_at=NOW,
        )
        assert entry.id == TIME_ENTRY_ID
        assert entry.hours == Decimal("8")


class TestTimeEntryUpdate:
    def test_empty_dict_accepted(self) -> None:
        """TimeEntryUpdate accepts an empty dict (all fields optional)."""
        update = TimeEntryUpdate()
        assert update.client_id is None
        assert update.work_date is None
        assert update.hours is None
        assert update.invoice_id is None
