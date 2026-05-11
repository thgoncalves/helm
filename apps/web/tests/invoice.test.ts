/**
 * Tests for the pure helpers in src/lib/invoice.ts.
 *
 * These are the dependency-free building blocks the Invoices pages rely on,
 * so they deserve a tight unit-test layer. The component-level tests in
 * tests/Invoices.test.tsx exercise the integration.
 */
import { describe, it, expect } from "vitest";
import {
  displayStatus,
  fiscalYearEnd,
  fiscalYearForDate,
  fiscalYearStart,
  formatCAD,
  invoiceTotals,
  lineTotals,
  num,
  round2,
  toIsoDate,
} from "@/lib/invoice";
import type { InvoiceLineItemInput } from "@/types/api";

describe("fiscal year math", () => {
  it("treats Jan/Feb/Mar as the previous FY", () => {
    expect(fiscalYearForDate(new Date(2026, 0, 1))).toBe(2025);
    expect(fiscalYearForDate(new Date(2026, 2, 31))).toBe(2025);
  });

  it("treats Apr 1 onwards as the new FY", () => {
    expect(fiscalYearForDate(new Date(2026, 3, 1))).toBe(2026);
    expect(fiscalYearForDate(new Date(2026, 11, 31))).toBe(2026);
  });

  it("fiscal year spans Apr 1 → Mar 31 next year", () => {
    expect(toIsoDate(fiscalYearStart(2026))).toBe("2026-04-01");
    expect(toIsoDate(fiscalYearEnd(2026))).toBe("2027-03-31");
  });
});

describe("num and round2", () => {
  it("coerces strings/null to numbers safely", () => {
    expect(num("1.5")).toBe(1.5);
    expect(num(2)).toBe(2);
    expect(num(null)).toBe(0);
    expect(num("")).toBe(0);
    expect(num("foo")).toBe(0);
  });

  it("rounds half-up to 2 decimal places", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.345)).toBe(2.35);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("formatCAD", () => {
  it("renders CAD currency with sign", () => {
    //   = non-breaking space (Intl outputs CA$1,234.56 with NBSP)
    const out = formatCAD(1234.56);
    expect(out).toMatch(/\$1,234\.56$/);
  });
});

describe("lineTotals", () => {
  const base: InvoiceLineItemInput = {
    line_order: 1,
    description: "Consulting",
    quantity: "10",
    unit_price: "100",
    is_taxable: true,
    tax_rate: "0.05",
    tax_category: "GST",
  };

  it("computes subtotal, tax, and total for a taxable line", () => {
    expect(lineTotals(base)).toEqual({
      subtotal: 1000,
      tax: 50,
      total: 1050,
    });
  });

  it("zeroes the tax when is_taxable is false", () => {
    expect(lineTotals({ ...base, is_taxable: false })).toEqual({
      subtotal: 1000,
      tax: 0,
      total: 1000,
    });
  });

  it("zeroes the tax when tax_rate is null even if taxable", () => {
    expect(lineTotals({ ...base, tax_rate: null })).toEqual({
      subtotal: 1000,
      tax: 0,
      total: 1000,
    });
  });

  it("handles fractional qty/unit_price like Wenco's 95.38/hr", () => {
    const wenco: InvoiceLineItemInput = {
      ...base,
      quantity: "10",
      unit_price: "95.38",
      tax_rate: "0.05",
    };
    expect(lineTotals(wenco)).toEqual({
      subtotal: 953.8,
      tax: 47.69,
      total: 1001.49,
    });
  });
});

describe("invoiceTotals", () => {
  it("sums totals across lines", () => {
    const lines: InvoiceLineItemInput[] = [
      {
        line_order: 1,
        description: "Consulting",
        quantity: "10",
        unit_price: "100",
        is_taxable: true,
        tax_rate: "0.05",
        tax_category: "GST",
      },
      {
        line_order: 2,
        description: "Travel",
        quantity: "1",
        unit_price: "200",
        is_taxable: false,
        tax_rate: null,
        tax_category: null,
      },
    ];
    expect(invoiceTotals(lines)).toEqual({
      subtotal: 1200,
      tax: 50,
      total: 1250,
    });
  });

  it("returns zeros for an empty list", () => {
    expect(invoiceTotals([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe("displayStatus", () => {
  const today = new Date(2026, 4, 11); // 2026-05-11

  it("returns draft / paid unchanged", () => {
    expect(displayStatus("draft", null, today)).toBe("draft");
    expect(displayStatus("paid", "2026-05-01", today)).toBe("paid");
  });

  it("flags a sent invoice with past due_date as overdue", () => {
    expect(displayStatus("sent", "2026-05-10", today)).toBe("overdue");
  });

  it("keeps a sent invoice with a future due_date in 'sent'", () => {
    expect(displayStatus("sent", "2026-06-01", today)).toBe("sent");
  });

  it("keeps a sent invoice in 'sent' when due_date is missing", () => {
    expect(displayStatus("sent", null, today)).toBe("sent");
  });
});
