"""FastAPI router for the ``/business/timesheets`` endpoints.

These are read-side views over ``time_entries``:

* ``GET /business/timesheets/summary`` — totals for a single client over a
  date range (typically a calendar month) plus contract-remaining figures
  (how many $ and hours are left on the active contract).
* ``GET /business/timesheets/pdf`` — render a PDF timesheet using the
  legacy Sulpetro template (see ``old_database/202604-001 Timesheet
  Sulpetro.pdf``). Returns ``application/pdf``.
"""

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app import db
from app.deps import get_current_user
from app.models.invoices import InvoiceRead
from app.routers.invoices import next_invoice_number_for_year

router = APIRouter(tags=["timesheets"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class TimesheetSummary(BaseModel):
    """Totals view for the timesheet page header.

    All decimal fields are JSON-serialised as strings (Pydantic v2 default)
    to preserve precision; the frontend coerces with ``Number()``.
    """

    client_id: UUID
    period_start: date
    period_end: date
    hourly_rate: Decimal | None
    contract_value: Decimal | None
    contract_currency: str | None
    # Period totals (for the requested [start, end] window).
    period_hours: Decimal
    period_amount: Decimal
    # Lifetime totals across all entries for this client.
    contract_hours_logged: Decimal
    contract_amount_logged: Decimal
    # Contract minus lifetime totals. Null when contract_value is null.
    contract_remaining_hours: Decimal | None
    contract_remaining_amount: Decimal | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_client(client_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM clients WHERE id = :id",
        {"id": client_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return row


def _decimal(value) -> Decimal:
    """Coerce a Data API numeric (already Decimal) or None to Decimal('0')."""
    return value if isinstance(value, Decimal) else Decimal(0)


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    last_day = monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


# ---------------------------------------------------------------------------
# GET /business/timesheets/summary
# ---------------------------------------------------------------------------


@router.get(
    "/summary",
    response_model=TimesheetSummary,
    summary="Totals for a client's timesheet over a date range",
)
async def get_summary(
    client_id: UUID = Query(...),
    start: date = Query(..., description="Inclusive start date (YYYY-MM-DD)."),
    end: date = Query(..., description="Inclusive end date (YYYY-MM-DD)."),
) -> TimesheetSummary:
    """Return period and lifetime totals for ``client_id``.

    The frontend uses period totals for the bottom-of-page month total, and
    the lifetime + contract values to compute "remaining $/hours".
    """
    if start > end:
        raise HTTPException(status_code=400, detail="start must be <= end")

    client = _fetch_client(client_id)
    rate = client["hourly_rate"] if isinstance(client["hourly_rate"], Decimal) else None
    contract_value = (
        client["contract_value"]
        if isinstance(client["contract_value"], Decimal)
        else None
    )

    period_row = db.fetch_one(
        """
        SELECT COALESCE(SUM(hours), 0) AS hours
        FROM time_entries
        WHERE client_id = :client_id
          AND work_date BETWEEN :start AND :end
        """,
        {"client_id": client_id, "start": start, "end": end},
    )
    period_hours = _decimal(period_row["hours"]) if period_row else Decimal(0)

    lifetime_row = db.fetch_one(
        """
        SELECT COALESCE(SUM(hours), 0) AS hours
        FROM time_entries
        WHERE client_id = :client_id
        """,
        {"client_id": client_id},
    )
    lifetime_hours = _decimal(lifetime_row["hours"]) if lifetime_row else Decimal(0)

    rate_for_money = rate if rate is not None else Decimal(0)
    period_amount = (period_hours * rate_for_money).quantize(Decimal("0.01"))
    lifetime_amount = (lifetime_hours * rate_for_money).quantize(Decimal("0.01"))

    if contract_value is not None and rate is not None:
        contract_total_hours = (contract_value / rate).quantize(Decimal("0.01"))
        remaining_hours = contract_total_hours - lifetime_hours
        remaining_amount = (contract_value - lifetime_amount).quantize(
            Decimal("0.01")
        )
    else:
        remaining_hours = None
        remaining_amount = None

    return TimesheetSummary(
        client_id=client_id,
        period_start=start,
        period_end=end,
        hourly_rate=rate,
        contract_value=contract_value,
        contract_currency=client["contract_currency"] or "CAD",
        period_hours=period_hours,
        period_amount=period_amount,
        contract_hours_logged=lifetime_hours,
        contract_amount_logged=lifetime_amount,
        contract_remaining_hours=remaining_hours,
        contract_remaining_amount=remaining_amount,
    )


# ---------------------------------------------------------------------------
# GET /business/timesheets/pdf
# ---------------------------------------------------------------------------


_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def _render_timesheet_pdf(
    *,
    user_name: str,
    user_email: str,
    user_phone: str,
    client_name: str,
    period_start: date,
    period_end: date,
    rate: Decimal,
    task_description: str,
    entries_by_date: dict[date, Decimal],
) -> bytes:
    """Render the timesheet PDF for ``period_start``..``period_end``.

    Replicates the legacy Sulpetro template: italic blue ``Timesheet`` title,
    contact block on the right, "Reference Month" + totals header, and a
    table that lists every day in the period (zero rows show ``0.00``).
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=f"Timesheet — {client_name}",
        author=user_name,
    )

    styles = getSampleStyleSheet()
    blue = colors.HexColor("#1F4E79")
    light_blue = colors.HexColor("#DCE6F1")
    grey_border = colors.HexColor("#BFBFBF")

    title_style = ParagraphStyle(
        "TimesheetTitle",
        parent=styles["Title"],
        fontName="Helvetica-BoldOblique",
        fontSize=36,
        textColor=blue,
        alignment=0,  # left
        spaceAfter=0,
    )
    contact_style = ParagraphStyle(
        "Contact",
        parent=styles["Normal"],
        fontSize=9,
        leading=12,
        alignment=2,  # right
    )
    label_style = ParagraphStyle(
        "Label",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.black,
        alignment=0,
    )

    contact_html = (
        f"<b>{user_name}</b><br/>{user_email}<br/>{user_phone}"
    )

    header_table = Table(
        [[Paragraph("<i>Timesheet</i>", title_style), Paragraph(contact_html, contact_style)]],
        colWidths=[105 * mm, 75 * mm],
    )
    header_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )

    # Compute totals.
    total_hours = sum(entries_by_date.values(), Decimal(0))
    total_cost = (total_hours * rate).quantize(Decimal("0.01"))

    # Reference month label — uses the month containing period_start.
    ref_label = f"{_MONTH_NAMES[period_start.month - 1]} of {period_start.year}"

    summary_table = Table(
        [
            [
                Paragraph("<b>Reference Month</b>", label_style),
                Paragraph("<b>TOTAL WORKED HOURS</b>", label_style),
                Paragraph("<b>TOTAL COST (CAD)</b>", label_style),
            ],
            [
                Paragraph(f"<b>{ref_label}</b>", label_style),
                Paragraph(f"<b>{total_hours:.2f}</b>", label_style),
                Paragraph(f"<b>$ {total_cost:,.2f}</b>", label_style),
            ],
        ],
        colWidths=[60 * mm, 60 * mm, 60 * mm],
    )
    summary_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (0, 0), 0.75, grey_border),
                ("BOX", (1, 1), (1, 1), 0.75, grey_border),
                ("BOX", (2, 1), (2, 1), 0.75, grey_border),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )

    # Entries table — every day in the period gets a row.
    rows: list[list[str]] = [["DATE(S)", "Task", "Hours Worked", "Cost", "Total"]]
    one_day = (period_end - period_start).days + 1
    for i in range(one_day):
        d = date.fromordinal(period_start.toordinal() + i)
        hours = entries_by_date.get(d, Decimal(0))
        if hours > 0:
            line_total = (hours * rate).quantize(Decimal("0.01"))
            rows.append(
                [
                    d.isoformat(),
                    task_description,
                    f"{hours:.2f}",
                    f"{rate:.2f}",
                    f"{line_total:.2f}",
                ]
            )
        else:
            rows.append([d.isoformat(), "", "", "", "0.00"])

    entries_table = Table(
        rows,
        colWidths=[28 * mm, 70 * mm, 28 * mm, 22 * mm, 32 * mm],
        repeatRows=1,
    )
    entries_table.setStyle(
        TableStyle(
            [
                # Header row
                ("BACKGROUND", (0, 0), (-1, 0), blue),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (0, 0), (-1, 0), "CENTER"),
                # Body
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
                ("ALIGN", (0, 1), (0, -1), "LEFT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, -1), 0.25, grey_border),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, light_blue]),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )

    story = [
        header_table,
        Spacer(1, 12 * mm),
        summary_table,
        Spacer(1, 6 * mm),
        entries_table,
    ]
    doc.build(story)
    return buf.getvalue()


def _get_setting(key: str, default: str = "") -> str:
    row = db.fetch_one(
        "SELECT value FROM settings WHERE key = :key",
        {"key": key},
    )
    return row["value"] if row else default


@router.get(
    "/pdf",
    summary="Export a client's timesheet as a PDF",
)
async def export_pdf(
    client_id: UUID = Query(...),
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
) -> StreamingResponse:
    """Return ``application/pdf`` for the given client + month.

    The PDF mirrors the legacy Sulpetro template (one row per calendar day,
    populated rows show ``client.default_task_description``).
    """
    client = _fetch_client(client_id)
    rate = client["hourly_rate"]
    if not isinstance(rate, Decimal):
        raise HTTPException(
            status_code=400,
            detail=(
                "Cannot export PDF: client has no hourly_rate set. "
                "Add one in the client edit form."
            ),
        )
    task_description = client["default_task_description"] or ""

    start, end = _month_bounds(year, month)
    rows = db.fetch_all(
        """
        SELECT work_date, hours FROM time_entries
        WHERE client_id = :client_id
          AND work_date BETWEEN :start AND :end
        """,
        {"client_id": client_id, "start": start, "end": end},
    )
    entries_by_date: dict[date, Decimal] = {
        r["work_date"]: r["hours"] for r in rows
    }

    # User contact info comes from the settings table (sole-consultant V1).
    # Add via the (forthcoming) settings UI, or seed in import_legacy.py.
    user_name = _get_setting("user_full_name") or _get_setting("company_name", "")
    user_email = _get_setting("user_email", "")
    user_phone = _get_setting("user_phone", "")

    pdf_bytes = _render_timesheet_pdf(
        user_name=user_name,
        user_email=user_email,
        user_phone=user_phone,
        client_name=client["name"],
        period_start=start,
        period_end=end,
        rate=rate,
        task_description=task_description,
        entries_by_date=entries_by_date,
    )

    invoice_prefix = f"{year:04d}{month:02d}-001"
    safe_client = "".join(c if c.isalnum() else "_" for c in client["name"])
    filename = f"{invoice_prefix} Timesheet {safe_client}.pdf"

    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Echo today's render time so cached browser tabs don't show stale.
            "X-Generated-At": datetime.now(timezone.utc).isoformat(),
        },
    )


# ---------------------------------------------------------------------------
# POST /business/timesheets/submit  — turn a month's entries into an invoice
# ---------------------------------------------------------------------------


class SubmitTimesheetBody(BaseModel):
    """Body for ``POST /business/timesheets/submit``.

    Attributes:
        client_id: The client whose timesheet is being submitted.
        year: 4-digit calendar year of the period.
        month: 1-12 month number of the period.
    """

    client_id: UUID
    year: int
    month: int


class SubmitTimesheetResponse(BaseModel):
    """Returned after a successful timesheet submission.

    Carries the new invoice so the frontend can immediately navigate to
    ``/invoices/{id}`` without a second round-trip.
    """

    invoice: InvoiceRead


@router.post(
    "/submit",
    response_model=SubmitTimesheetResponse,
    status_code=201,
    summary="Submit a month's timesheet — creates an invoice and links entries",
)
async def submit_timesheet(body: SubmitTimesheetBody) -> SubmitTimesheetResponse:
    """Create an invoice for the month from this client's time entries.

    Behaviour:

    * Sums hours for all uninvoiced entries in ``[period_start, period_end]``.
    * Generates a single line item ``"Consulting Services - N hours"`` priced
      at ``client.hourly_rate``.
    * Applies the client's ``default_taxable``, ``default_tax_rate`` and
      ``default_payment_terms_days`` for the GST line and due date.
    * Allocates a new ``INV-{year}-{NNNN}`` number using the current year.
    * Links every consumed time entry to the new invoice (so the bulk
      upsert won't subsequently delete them — see
      :func:`bulk_upsert_time_entries`).

    Returns 400 if the client has no rate or no uninvoiced hours in the
    period.
    """
    if not 1 <= body.month <= 12:
        raise HTTPException(status_code=400, detail="month must be 1-12")

    client = _fetch_client(body.client_id)
    rate = client["hourly_rate"]
    if not isinstance(rate, Decimal):
        raise HTTPException(
            status_code=400,
            detail="Client has no hourly_rate set — cannot submit a timesheet.",
        )

    start, end = _month_bounds(body.year, body.month)
    rows = db.fetch_all(
        """
        SELECT id, hours FROM time_entries
        WHERE client_id = :client_id
          AND work_date BETWEEN :start AND :end
          AND invoice_id IS NULL
        """,
        {"client_id": body.client_id, "start": start, "end": end},
    )
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No uninvoiced hours in this period — nothing to submit.",
        )

    total_hours = sum(
        (r["hours"] for r in rows if isinstance(r["hours"], Decimal)),
        Decimal(0),
    )
    subtotal = (total_hours * rate).quantize(Decimal("0.01"))

    is_taxable: bool = bool(client.get("default_taxable", True))
    raw_tax_rate = client.get("default_tax_rate")
    tax_rate: Decimal | None = raw_tax_rate if isinstance(raw_tax_rate, Decimal) else None
    if is_taxable and tax_rate is not None and tax_rate > 0:
        tax_amount = (subtotal * tax_rate).quantize(Decimal("0.01"))
    else:
        tax_amount = Decimal("0.00")
    total = (subtotal + tax_amount).quantize(Decimal("0.01"))

    issue_date = date.today()
    raw_terms_days = client.get("default_payment_terms_days")
    payment_terms_days: int = (
        int(raw_terms_days) if isinstance(raw_terms_days, (int, Decimal)) else 30
    )
    due_date = issue_date + timedelta(days=payment_terms_days)
    payment_terms_text = f"Net {payment_terms_days}"

    invoice_number = next_invoice_number_for_year(issue_date.year)
    notes = f"Timesheet period: {start.isoformat()} to {end.isoformat()}"
    # Hours live in the line item's quantity (shown in the invoice's HOURS
    # column), so the description doesn't repeat them.
    description = "Consulting Services"

    now = datetime.now(timezone.utc)
    invoice_id = uuid4()
    invoice_row = db.fetch_one(
        """
        INSERT INTO invoices (
            id, invoice_number, issue_date, due_date, client_id,
            status, currency, subtotal, tax_amount, total,
            notes, payment_terms, attachments_path,
            created_at, updated_at
        ) VALUES (
            :id, :invoice_number, :issue_date, :due_date, :client_id,
            'draft', :currency, :subtotal, :tax_amount, :total,
            :notes, :payment_terms, NULL,
            :created_at, :updated_at
        )
        RETURNING *
        """,
        {
            "id": invoice_id,
            "invoice_number": invoice_number,
            "issue_date": issue_date,
            "due_date": due_date,
            "client_id": body.client_id,
            "currency": client.get("contract_currency") or "CAD",
            "subtotal": subtotal,
            "tax_amount": tax_amount,
            "total": total,
            "notes": notes,
            "payment_terms": payment_terms_text,
            "created_at": now,
            "updated_at": now,
        },
    )
    assert invoice_row is not None

    db.execute(
        """
        INSERT INTO invoice_line_items (
            id, invoice_id, line_order, description,
            quantity, unit_price, tax_category,
            is_taxable, tax_rate,
            line_subtotal, line_tax, line_total
        ) VALUES (
            :id, :invoice_id, 1, :description,
            :quantity, :unit_price, :tax_category,
            :is_taxable, :tax_rate,
            :subtotal, :tax_amount, :total
        )
        """,
        {
            "id": uuid4(),
            "invoice_id": invoice_id,
            "description": description,
            "quantity": total_hours,
            "unit_price": rate,
            "tax_category": "GST" if is_taxable and tax_rate else None,
            "is_taxable": is_taxable,
            "tax_rate": tax_rate,
            "subtotal": subtotal,
            "tax_amount": tax_amount,
            "total": total,
        },
    )

    # Link each consumed entry so the bulk upsert can't touch them later.
    for r in rows:
        db.execute(
            """
            UPDATE time_entries
            SET invoice_id = :invoice_id, updated_at = :now
            WHERE id = :id
            """,
            {"id": r["id"], "invoice_id": invoice_id, "now": now},
        )

    return SubmitTimesheetResponse(invoice=InvoiceRead(**invoice_row))
