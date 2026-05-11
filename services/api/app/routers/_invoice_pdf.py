"""reportlab template that renders the V1 invoice PDF.

Replicates ``old_database/INV-2026-0025 Invoice.pdf``:

* Top-left sender block (all caps name, address, postal code, phone, email
  in blue).
* "INVOICE  <number>" header.
* Client name on its own line.
* Two-column table: Description / Amount.
* Lines summed; a "GST (5%)" row if any of the lines were taxable.
* "Total" row highlighted in yellow.
* "e-Transfer account: ..." note at the bottom.
"""

from __future__ import annotations

from decimal import Decimal
from io import BytesIO
from typing import Any, Mapping

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


def _money(value: Decimal | float | int | None) -> str:
    """Format a money value as ``1,234.56`` (no $ sign — the column header
    already says "Amount")."""
    if value is None:
        return "0.00"
    return f"{Decimal(value):,.2f}"


def _percent(rate: Decimal | None) -> str:
    if rate is None:
        return "0%"
    pct = (Decimal(rate) * Decimal(100)).quantize(Decimal("0.01"))
    # Trim trailing zeros — "5%" instead of "5.00%".
    s = str(pct)
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return f"{s}%"


def render_invoice_pdf(
    *,
    invoice: Mapping[str, Any],
    line_items: list[Mapping[str, Any]],
    client_name: str,
    user_name: str,
    user_address: str,
    user_postal_code: str,
    user_phone: str,
    user_email: str,
    etransfer_email: str,
) -> bytes:
    """Render the invoice PDF and return raw ``application/pdf`` bytes.

    Args:
        invoice: The invoice row (matches the ``invoices`` table shape).
        line_items: Ordered list of line item rows. Each line uses
            ``description``, ``quantity``, ``unit_price``,
            ``is_taxable``, ``tax_rate``, ``line_subtotal``, ``line_tax``
            and ``line_total``.
        client_name: Display name printed under the INVOICE header.
        user_name, user_address, user_postal_code, user_phone,
            user_email: Sender block (read from the ``settings`` table).
        etransfer_email: Address shown in the footer.
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=f"Invoice {invoice['invoice_number']}",
        author=user_name,
    )

    styles = getSampleStyleSheet()
    blue = colors.HexColor("#0563C1")
    yellow = colors.HexColor("#FFFF00")
    grey = colors.HexColor("#7F7F7F")

    sender_name_style = ParagraphStyle(
        "SenderName",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=16,
        textColor=colors.black,
        spaceAfter=0,
    )
    sender_line_style = ParagraphStyle(
        "SenderLine",
        parent=styles["Normal"],
        fontSize=10,
        leading=12,
    )
    sender_email_style = ParagraphStyle(
        "SenderEmail",
        parent=sender_line_style,
        textColor=blue,
        fontName="Helvetica",
    )
    invoice_header_style = ParagraphStyle(
        "InvoiceHeader",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        spaceBefore=10,
        spaceAfter=6,
    )
    client_style = ParagraphStyle(
        "ClientName",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        spaceBefore=4,
        spaceAfter=10,
    )

    story: list = [
        Paragraph(user_name.upper(), sender_name_style),
        Paragraph(user_address, sender_line_style),
        Paragraph(user_postal_code, sender_line_style),
        Paragraph(user_phone, sender_line_style),
        Paragraph(user_email, sender_email_style),
        Paragraph(
            f"<b>INVOICE</b> &nbsp;&nbsp; {invoice['invoice_number']}",
            invoice_header_style,
        ),
        Paragraph(client_name, client_style),
    ]

    # Build the line-item table. We collapse same-rate taxable lines into a
    # single "GST (5%)" row at the bottom to match the legacy template,
    # which only shows the GST aggregate.
    table_rows: list[list[str]] = [["Description", "Amount"]]
    for ln in line_items:
        subtotal = ln.get("line_subtotal") or Decimal("0")
        table_rows.append([ln["description"], _money(subtotal)])

    total_tax = Decimal("0.00")
    rate_seen: Decimal | None = None
    for ln in line_items:
        if ln.get("is_taxable"):
            line_tax = ln.get("line_tax") or Decimal("0")
            if line_tax != 0:
                total_tax += Decimal(line_tax)
                rate_seen = (
                    Decimal(ln["tax_rate"]) if ln.get("tax_rate") is not None else None
                )

    if total_tax > 0:
        table_rows.append([f"GST ({_percent(rate_seen)})", _money(total_tax)])

    table_rows.append(["Total", _money(invoice["total"])])

    n_rows = len(table_rows)
    total_row_idx = n_rows - 1

    table = Table(
        table_rows,
        colWidths=[120 * mm, 50 * mm],
    )
    style_cmds: list = [
        # Header row
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F2F2F2")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (0, 0), (0, 0), "CENTER"),
        ("ALIGN", (1, 0), (1, 0), "CENTER"),
        # Body
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 1), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.25, grey),
        # Total row highlight (yellow background, bold black text).
        ("BACKGROUND", (0, total_row_idx), (-1, total_row_idx), yellow),
        ("FONTNAME", (0, total_row_idx), (-1, total_row_idx), "Helvetica-Bold"),
    ]
    # If there's a GST row, right-align its label column too (matches the
    # legacy template, where "GST (5%)" is right-aligned).
    if total_tax > 0:
        gst_row_idx = n_rows - 2
        style_cmds.append(("ALIGN", (0, gst_row_idx), (0, gst_row_idx), "RIGHT"))

    table.setStyle(TableStyle(style_cmds))
    story.append(table)
    story.append(Spacer(1, 12 * mm))

    footer_box = Table(
        [[f"e-Transfer account: {etransfer_email}"]],
        colWidths=[170 * mm],
    )
    footer_box.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.25, grey),
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(footer_box)

    doc.build(story)
    return buf.getvalue()
