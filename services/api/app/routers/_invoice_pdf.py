"""reportlab template that renders the invoice PDF.

Replicates ``old_database/Invoice_Template.pdf`` — a clean, modern layout:

* Header: company name + sender block on the left, large "INVOICE" wordmark
  and ``# <number>`` on the right, separated by a thin rule.
* "BILL TO" / client name on the left; an "INVOICE DATE / DUE / AMOUNT DUE"
  info block on the right.
* Line-item table with a dark navy header: Description / Hours / Rate /
  Amount.
* Right-aligned Subtotal and "GST (n%)" rows, then a dark navy TOTAL bar.
* A light-grey "PAYMENT INSTRUCTIONS" panel with the e-Transfer address.
* Centered "<company> · Thank you for your business." footer.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from typing import Any, Mapping
from xml.sax.saxutils import escape

# Trailing "- 26 hours" / "- 26.5 hrs" / "- 26h" — redundant now that hours
# have their own column. Stripped from line-item descriptions on render so
# legacy invoices (whose stored text still embeds the hours) look clean too.
_HOURS_SUFFIX_RE = re.compile(
    r"\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)\s*$",
    re.IGNORECASE,
)


def _strip_hours_suffix(description: str) -> str:
    return _HOURS_SUFFIX_RE.sub("", description)

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# Palette — a dark slate navy for emphasis bars, muted greys for labels.
NAVY = colors.HexColor("#1F2D3D")
LABEL_GREY = colors.HexColor("#6B7280")
BODY_DARK = colors.HexColor("#1F2937")
RULE_GREY = colors.HexColor("#D8DCE1")
PANEL_GREY = colors.HexColor("#F3F4F6")


def _money(value: Decimal | float | int | None) -> str:
    """Format a money value as ``1,234.56`` (no $ sign — callers prepend it)."""
    if value is None:
        return "0.00"
    return f"{Decimal(value):,.2f}"


def _qty(value: Decimal | float | int | None) -> str:
    """Format a quantity, trimming trailing zeros (``26``, ``26.5``)."""
    if value is None:
        return "0"
    s = f"{Decimal(value):,.2f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _percent(rate: Decimal | None) -> str:
    if rate is None:
        return "0"
    pct = (Decimal(rate) * Decimal(100)).quantize(Decimal("0.01"))
    s = str(pct)
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _fmt_date(value: Any) -> str:
    """Render a date as ``May 1, 2026``. Accepts date/datetime/ISO string."""
    if value is None:
        return "—"
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value).date()
        except ValueError:
            return value
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return f"{value.strftime('%b')} {value.day}, {value.year}"
    return str(value)


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
    company_name: str = "",
) -> bytes:
    """Render the invoice PDF and return raw ``application/pdf`` bytes.

    Args:
        invoice: The invoice row (matches the ``invoices`` table shape).
        line_items: Ordered list of line item rows. Each line uses
            ``description``, ``quantity``, ``unit_price``,
            ``is_taxable``, ``tax_rate``, ``line_subtotal``, ``line_tax``
            and ``line_total``.
        client_name: Display name printed under "BILL TO".
        user_name, user_address, user_postal_code, user_phone,
            user_email: Sender block (read from the ``settings`` table).
        etransfer_email: Address shown in the payment-instructions panel.
        company_name: Legal company name shown as the header wordmark. Falls
            back to ``user_name`` when blank.
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"Invoice {invoice['invoice_number']}",
        author=company_name or user_name,
    )

    content_width = doc.width  # page width minus left/right margins (~170mm).
    currency = invoice.get("currency") or "CAD"

    styles = getSampleStyleSheet()
    company_style = ParagraphStyle(
        "Company",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=17,
        textColor=NAVY,
        leading=20,
        spaceAfter=2,
    )
    sender_line = ParagraphStyle(
        "SenderLine",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        leading=13,
        textColor=LABEL_GREY,
    )
    invoice_word = ParagraphStyle(
        "InvoiceWord",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=28,
        textColor=NAVY,
        alignment=TA_RIGHT,
        leading=30,
        spaceAfter=2,
    )
    invoice_num = ParagraphStyle(
        "InvoiceNum",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=10,
        textColor=NAVY,
        alignment=TA_RIGHT,
    )
    section_label = ParagraphStyle(
        "SectionLabel",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=8,
        textColor=LABEL_GREY,
        leading=12,
        spaceAfter=3,
    )
    client_style = ParagraphStyle(
        "Client",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=13,
        textColor=BODY_DARK,
        leading=16,
    )
    desc_style = ParagraphStyle(
        "Desc",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=10,
        textColor=BODY_DARK,
        leading=13,
        alignment=TA_LEFT,
    )
    panel_label = ParagraphStyle(
        "PanelLabel",
        parent=section_label,
        spaceAfter=4,
    )
    panel_line = ParagraphStyle(
        "PanelLine",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=9.5,
        textColor=BODY_DARK,
        leading=14,
    )
    panel_email = ParagraphStyle(
        "PanelEmail",
        parent=panel_line,
        fontName="Helvetica-Bold",
    )
    footer_style = ParagraphStyle(
        "Footer",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        textColor=LABEL_GREY,
        alignment=TA_CENTER,
    )

    story: list = []

    # --- Header: sender block (left) + INVOICE wordmark (right) --------------
    company_display = company_name or user_name
    left_block: list = [Paragraph(escape(company_display), company_style)]
    if user_name and user_name != company_display:
        left_block.append(Paragraph(escape(user_name), sender_line))
    address_bits = [b for b in (user_address, user_postal_code) if b]
    if address_bits:
        left_block.append(Paragraph(escape(", ".join(address_bits)), sender_line))
    contact_bits = [escape(b) for b in (user_phone, user_email) if b]
    if contact_bits:
        left_block.append(Paragraph(" &middot; ".join(contact_bits), sender_line))

    right_block = [
        Paragraph("INVOICE", invoice_word),
        Paragraph(f"# {escape(str(invoice['invoice_number']))}", invoice_num),
    ]

    header = Table(
        [[left_block, right_block]],
        colWidths=[content_width * 0.6, content_width * 0.4],
    )
    header.setStyle(
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
    story.append(header)
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", thickness=0.75, color=RULE_GREY))
    story.append(Spacer(1, 10))

    # --- Bill-to (left) + invoice meta (right) -------------------------------
    info_rows = [
        ["INVOICE DATE", _fmt_date(invoice.get("issue_date"))],
        ["DUE", _fmt_date(invoice.get("due_date"))],
        ["AMOUNT DUE", f"${_money(invoice['total'])} {currency}"],
    ]
    info = Table(info_rows, colWidths=[content_width * 0.22, content_width * 0.18])
    info.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica"),
                ("TEXTCOLOR", (0, 0), (0, -1), LABEL_GREY),
                ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (1, 0), (1, -1), BODY_DARK),
                ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, -1), 8),
                ("RIGHTPADDING", (1, 0), (1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )

    bill_to_block = [
        Paragraph("BILL TO", section_label),
        Paragraph(escape(client_name), client_style),
    ]
    meta = Table(
        [[bill_to_block, info]],
        colWidths=[content_width * 0.6, content_width * 0.4],
    )
    meta.setStyle(
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
    story.append(meta)
    story.append(Spacer(1, 16))

    # --- Line-item table + summary -------------------------------------------
    desc_w = content_width * 0.50
    num_w = (content_width - desc_w) / 3.0
    col_widths = [desc_w, num_w, num_w, num_w]

    rows: list[list[Any]] = [["DESCRIPTION", "HOURS", "RATE", "AMOUNT"]]
    for ln in line_items:
        rows.append(
            [
                Paragraph(escape(_strip_hours_suffix(ln["description"])), desc_style),
                _qty(ln.get("quantity")),
                f"${_money(ln.get('unit_price'))}",
                f"${_money(ln.get('line_subtotal') or Decimal('0'))}",
            ]
        )
    last_item_idx = len(rows) - 1

    # Collapse taxable lines into a single "GST (n%)" row, matching the
    # template, which shows only the GST aggregate.
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

    rows.append(["", "Subtotal", "", f"${_money(invoice['subtotal'])}"])
    subtotal_idx = len(rows) - 1
    gst_idx: int | None = None
    if total_tax > 0:
        rows.append(
            ["", f"GST ({_percent(rate_seen)}%)", "", f"${_money(total_tax)}"]
        )
        gst_idx = len(rows) - 1
    rows.append(["", f"TOTAL ({currency})", "", f"${_money(invoice['total'])}"])
    total_idx = len(rows) - 1

    table = Table(rows, colWidths=col_widths)
    style_cmds: list = [
        # Header bar.
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("ALIGN", (0, 0), (0, 0), "LEFT"),
        ("ALIGN", (1, 0), (-1, 0), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        # Line-item body.
        ("FONTNAME", (0, 1), (-1, last_item_idx), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, last_item_idx), 10),
        ("TEXTCOLOR", (0, 1), (-1, last_item_idx), BODY_DARK),
        ("ALIGN", (1, 1), (-1, last_item_idx), "RIGHT"),
        ("VALIGN", (0, 1), (-1, last_item_idx), "MIDDLE"),
        ("TOPPADDING", (0, 1), (-1, last_item_idx), 8),
        ("BOTTOMPADDING", (0, 1), (-1, last_item_idx), 8),
        # Separator under the last line item.
        ("LINEBELOW", (0, last_item_idx), (-1, last_item_idx), 0.5, RULE_GREY),
        # Shared column padding.
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        # Summary rows: label spans Hours+Rate columns, value in Amount.
        ("SPAN", (1, subtotal_idx), (2, subtotal_idx)),
        ("SPAN", (1, total_idx), (2, total_idx)),
        ("ALIGN", (1, subtotal_idx), (-1, total_idx), "RIGHT"),
        ("VALIGN", (0, subtotal_idx), (-1, total_idx), "MIDDLE"),
        ("FONTNAME", (1, subtotal_idx), (-1, subtotal_idx), "Helvetica"),
        ("FONTSIZE", (1, subtotal_idx), (-1, total_idx), 10),
        ("TEXTCOLOR", (1, subtotal_idx), (-1, subtotal_idx), BODY_DARK),
        ("TOPPADDING", (1, subtotal_idx), (-1, subtotal_idx), 7),
        ("BOTTOMPADDING", (1, subtotal_idx), (-1, subtotal_idx), 3),
        # TOTAL bar (navy, white, bold) over Hours..Amount.
        ("BACKGROUND", (1, total_idx), (-1, total_idx), NAVY),
        ("TEXTCOLOR", (1, total_idx), (-1, total_idx), colors.white),
        ("FONTNAME", (1, total_idx), (-1, total_idx), "Helvetica-Bold"),
        ("FONTSIZE", (1, total_idx), (-1, total_idx), 11),
        ("TOPPADDING", (1, total_idx), (-1, total_idx), 9),
        ("BOTTOMPADDING", (1, total_idx), (-1, total_idx), 9),
    ]
    if gst_idx is not None:
        style_cmds += [
            ("SPAN", (1, gst_idx), (2, gst_idx)),
            ("ALIGN", (1, gst_idx), (-1, gst_idx), "RIGHT"),
            ("FONTNAME", (1, gst_idx), (-1, gst_idx), "Helvetica"),
            ("FONTSIZE", (1, gst_idx), (-1, gst_idx), 10),
            ("TEXTCOLOR", (1, gst_idx), (-1, gst_idx), BODY_DARK),
            ("TOPPADDING", (1, gst_idx), (-1, gst_idx), 3),
            ("BOTTOMPADDING", (1, gst_idx), (-1, gst_idx), 3),
        ]
    table.setStyle(TableStyle(style_cmds))
    story.append(table)
    story.append(Spacer(1, 18))

    # --- Payment instructions panel ------------------------------------------
    panel_inner = [
        Paragraph("PAYMENT INSTRUCTIONS", panel_label),
        Paragraph("Please send payment via Interac e-Transfer to:", panel_line),
        Paragraph(escape(etransfer_email), panel_email),
    ]
    panel = Table([[panel_inner]], colWidths=[content_width])
    panel.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL_GREY),
                ("LEFTPADDING", (0, 0), (-1, -1), 14),
                ("RIGHTPADDING", (0, 0), (-1, -1), 14),
                ("TOPPADDING", (0, 0), (-1, -1), 12),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
            ]
        )
    )
    story.append(panel)
    story.append(Spacer(1, 16))

    # --- Footer ---------------------------------------------------------------
    story.append(HRFlowable(width="100%", thickness=0.75, color=RULE_GREY))
    story.append(Spacer(1, 8))
    story.append(
        Paragraph(
            f"{escape(company_display)} &middot; Thank you for your business.",
            footer_style,
        )
    )

    doc.build(story)
    return buf.getvalue()
