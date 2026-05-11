/**
 * Pure helpers for the Invoices feature.
 *
 * Two concerns live here:
 * 1. Fiscal-year math — the business's fiscal year starts every April 1st,
 *    so the landing page's default filter is April 1 → March 31 of the
 *    current FY.
 * 2. Line-item / invoice totals — kept pure so the form can show live totals
 *    without round-tripping to the server. The server still re-computes
 *    these on save, so the UI math is purely cosmetic.
 */

import type { InvoiceLineItemInput } from "@/types/api";

// ---------------------------------------------------------------------------
// Fiscal year
// ---------------------------------------------------------------------------

/** Returns the calendar year in which the fiscal year containing `d` begins. */
export function fiscalYearForDate(d: Date): number {
  // FY starts April 1. Jan/Feb/Mar belong to the previous FY.
  return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
}

/** Start of the fiscal year that begins in `fyStartYear` (April 1). */
export function fiscalYearStart(fyStartYear: number): Date {
  return new Date(fyStartYear, 3, 1); // April = month 3 (0-indexed)
}

/** Inclusive end of the fiscal year that begins in `fyStartYear` (March 31). */
export function fiscalYearEnd(fyStartYear: number): Date {
  return new Date(fyStartYear + 1, 2, 31);
}

/** Format a Date as YYYY-MM-DD (local). */
export function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/** Coerce a string/number/null to a number, returning 0 for falsy/NaN input. */
export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isNaN(n) ? 0 : n;
}

/** Format a number as CAD currency. */
export function formatCAD(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(amount);
}

/** Round half-up to 2 decimal places, returning a number. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Compute (subtotal, tax, total) for a single line. */
export function lineTotals(line: InvoiceLineItemInput): {
  subtotal: number;
  tax: number;
  total: number;
} {
  const qty = num(line.quantity);
  const unit = num(line.unit_price);
  const rate = num(line.tax_rate);
  const subtotal = round2(qty * unit);
  const tax = line.is_taxable && rate > 0 ? round2(subtotal * rate) : 0;
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/** Sum (subtotal, tax, total) across a list of line items. */
export function invoiceTotals(lines: InvoiceLineItemInput[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    const t = lineTotals(line);
    subtotal += t.subtotal;
    tax += t.tax;
  }
  subtotal = round2(subtotal);
  tax = round2(tax);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Returns the display status considering "overdue" as a derived state.
 * Used for badges/colour-coding in the listing.
 */
export function displayStatus(
  status: string,
  dueDate: string | null,
  today: Date = new Date(),
): "draft" | "sent" | "overdue" | "paid" | "other" {
  if (status === "draft") return "draft";
  if (status === "paid") return "paid";
  if (status === "sent") {
    if (dueDate) {
      const [y, m, d] = dueDate.split("-").map(Number) as [
        number,
        number,
        number,
      ];
      const due = new Date(y, m - 1, d);
      // Compare midnight-to-midnight.
      const todayMid = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      );
      if (due < todayMid) return "overdue";
    }
    return "sent";
  }
  return "other";
}
