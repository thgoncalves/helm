/**
 * Tests for src/lib/pacing.ts.
 *
 * Covers the main business-day counting cases used by the Timesheets
 * pacing widget: weekends-only spans, stat holidays, vacation overlap,
 * and inverted date ranges.
 */
import { describe, it, expect } from "vitest";
import { businessDaysBetween, requiredPace } from "@/lib/pacing";
import type { VacationPeriod } from "@/lib/holidays";

// ---------------------------------------------------------------------------
// businessDaysBetween
// ---------------------------------------------------------------------------

describe("businessDaysBetween", () => {
  it("returns 0 business days for a weekend-only span", () => {
    // 2026-05-16 = Saturday, 2026-05-17 = Sunday
    const result = businessDaysBetween(
      "2026-05-16",
      "2026-05-17",
      new Set<string>(),
      [],
    );
    expect(result.totalBusinessDays).toBe(0);
    expect(result.holidayDaysDeducted).toBe(0);
    expect(result.vacationDaysDeducted).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it("counts Mon–Fri inclusive for a normal work week", () => {
    // 2026-05-11 (Mon) to 2026-05-15 (Fri) = 5 days
    const result = businessDaysBetween(
      "2026-05-11",
      "2026-05-15",
      new Set<string>(),
      [],
    );
    expect(result.totalBusinessDays).toBe(5);
    expect(result.remaining).toBe(5);
  });

  it("deducts exactly one holiday from a ten-business-day span", () => {
    // 2026-09-07 is Labour Day (1st Mon Sep) — falls in the Mon–Fri window.
    // Span: 2026-08-31 (Mon) to 2026-09-11 (Fri) = 10 business days.
    const holidays = new Set<string>(["2026-09-07"]);
    const result = businessDaysBetween(
      "2026-08-31",
      "2026-09-11",
      holidays,
      [],
    );
    expect(result.totalBusinessDays).toBe(10);
    expect(result.holidayDaysDeducted).toBe(1);
    expect(result.vacationDaysDeducted).toBe(0);
    expect(result.remaining).toBe(9);
  });

  it("deducts vacation days from the same ten-business-day span", () => {
    // Same span + 1 holiday, plus a vacation that overlaps two business days.
    // Vacation: 2026-09-08 (Tue) to 2026-09-09 (Wed) — both weekdays.
    const holidays = new Set<string>(["2026-09-07"]);
    const vacations: VacationPeriod[] = [
      { start: "2026-09-08", end: "2026-09-09", label: "Long weekend extension" },
    ];
    const result = businessDaysBetween(
      "2026-08-31",
      "2026-09-11",
      holidays,
      vacations,
    );
    expect(result.totalBusinessDays).toBe(10);
    expect(result.holidayDaysDeducted).toBe(1);
    expect(result.vacationDaysDeducted).toBe(2);
    expect(result.remaining).toBe(7);
  });

  it("a holiday that overlaps a vacation day counts as a holiday (not vacation)", () => {
    // Holiday on 2026-09-07, vacation spans 2026-09-05 to 2026-09-07.
    // 2026-09-07 is Labour Day → holiday wins. 2026-09-05 (Sat) is a weekend.
    // Only 2026-09-07 (Mon) in the span: vacation can only claim 0 business days
    // from the overlap because the holiday already covers the one overlapping weekday.
    const holidays = new Set<string>(["2026-09-07"]);
    const vacations: VacationPeriod[] = [
      { start: "2026-09-05", end: "2026-09-07", label: "Weekend camping" },
    ];
    const result = businessDaysBetween(
      "2026-09-07",
      "2026-09-07",
      holidays,
      vacations,
    );
    expect(result.totalBusinessDays).toBe(1);
    expect(result.holidayDaysDeducted).toBe(1);
    expect(result.vacationDaysDeducted).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// requiredPace
// ---------------------------------------------------------------------------

describe("requiredPace", () => {
  it("returns null when end is before start (inverted range)", () => {
    const result = requiredPace({
      remainingHours: 100,
      fromIso: "2026-05-17",
      toIso: "2026-05-11",
      holidayIsos: new Set<string>(),
      vacations: [],
    });
    expect(result).toBeNull();
  });

  it("returns Infinity hoursPerDay when remaining days is 0", () => {
    // Span is a weekend only — 0 business days available.
    const result = requiredPace({
      remainingHours: 50,
      fromIso: "2026-05-16",
      toIso: "2026-05-17",
      holidayIsos: new Set<string>(),
      vacations: [],
    });
    expect(result).not.toBeNull();
    expect(result!.hoursPerDay).toBe(Infinity);
    expect(result!.businessDaysRemaining).toBe(0);
  });

  it("computes correct pace for ten business days with holiday and vacation", () => {
    // 10 business days, -1 holiday, -2 vacation = 7 available.
    // 200 remaining hours / 7 days ≈ 28.57 h/day.
    const holidays = new Set<string>(["2026-09-07"]);
    const vacations: VacationPeriod[] = [
      { start: "2026-09-08", end: "2026-09-09", label: "Extension" },
    ];
    const result = requiredPace({
      remainingHours: 200,
      fromIso: "2026-08-31",
      toIso: "2026-09-11",
      holidayIsos: holidays,
      vacations,
    });
    expect(result).not.toBeNull();
    expect(result!.businessDaysRemaining).toBe(7);
    expect(result!.holidayDaysDeducted).toBe(1);
    expect(result!.vacationDaysDeducted).toBe(2);
    expect(result!.hoursPerDay).toBeCloseTo(200 / 7, 5);
  });

  it("handles same-day range (single business day)", () => {
    // 2026-05-11 is a Monday → 1 business day.
    const result = requiredPace({
      remainingHours: 8,
      fromIso: "2026-05-11",
      toIso: "2026-05-11",
      holidayIsos: new Set<string>(),
      vacations: [],
    });
    expect(result).not.toBeNull();
    expect(result!.businessDaysRemaining).toBe(1);
    expect(result!.hoursPerDay).toBe(8);
  });
});
