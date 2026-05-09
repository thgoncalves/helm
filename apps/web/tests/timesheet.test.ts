/**
 * Tests for the pure helpers in src/lib/timesheet.ts.
 *
 * These are the dependency-free building blocks the page relies on, so they
 * deserve a tight unit-test layer. The component-level tests in
 * tests/Timesheets.test.tsx exercise the integration.
 */
import { describe, it, expect } from "vitest";
import {
  addDays,
  buildCalendar,
  endOfMonth,
  formatCAD,
  formatMonthLabel,
  startOfWeekMonday,
  sumHours,
  toIsoDate,
} from "@/lib/timesheet";

describe("toIsoDate / startOfWeekMonday / addDays", () => {
  it("formats a Date as YYYY-MM-DD in local time", () => {
    expect(toIsoDate(new Date(2026, 4, 9))).toBe("2026-05-09");
  });

  it("rolls a Saturday back to the prior Monday", () => {
    // 2026-05-09 is a Saturday.
    const sat = new Date(2026, 4, 9);
    const mon = startOfWeekMonday(sat);
    expect(toIsoDate(mon)).toBe("2026-05-04");
  });

  it("returns the same day when input is already a Monday", () => {
    const mon = new Date(2026, 4, 4);
    expect(toIsoDate(startOfWeekMonday(mon))).toBe("2026-05-04");
  });

  it("addDays moves forward and back across month boundaries", () => {
    expect(toIsoDate(addDays(new Date(2026, 4, 1), -1))).toBe("2026-04-30");
    expect(toIsoDate(addDays(new Date(2026, 4, 30), 5))).toBe("2026-06-04");
  });
});

describe("endOfMonth", () => {
  it("returns the last day of a 31-day month", () => {
    expect(toIsoDate(endOfMonth(2026, 5))).toBe("2026-05-31");
  });

  it("handles February in a non-leap year", () => {
    expect(toIsoDate(endOfMonth(2026, 2))).toBe("2026-02-28");
  });

  it("handles February in a leap year", () => {
    expect(toIsoDate(endOfMonth(2024, 2))).toBe("2024-02-29");
  });
});

describe("buildCalendar", () => {
  it("starts on the Monday of the week containing the 1st", () => {
    // May 2026: 1st is a Friday → first row begins Mon Apr 27.
    const weeks = buildCalendar(2026, 5);
    expect(weeks[0]?.cells[0]?.iso).toBe("2026-04-27");
    expect(weeks[0]?.cells[6]?.iso).toBe("2026-05-03");
  });

  it("ends with the week containing the last day", () => {
    const weeks = buildCalendar(2026, 5);
    const last = weeks[weeks.length - 1];
    // Sunday of the last row.
    expect(last?.cells[6]?.iso).toBe("2026-05-31");
  });

  it("flags out-of-month cells as inMonth=false", () => {
    const weeks = buildCalendar(2026, 5);
    expect(weeks[0]?.cells[0]?.inMonth).toBe(false); // Apr 27
    expect(weeks[0]?.cells[4]?.inMonth).toBe(true); // May 1
  });

  it("flags Sat and Sun as weekend", () => {
    const weeks = buildCalendar(2026, 5);
    const sat = weeks[0]?.cells[5];
    const sun = weeks[0]?.cells[6];
    expect(sat?.isWeekend).toBe(true);
    expect(sun?.isWeekend).toBe(true);
  });

  it("produces 5 rows for May 2026 (Friday-start, 31 days)", () => {
    expect(buildCalendar(2026, 5)).toHaveLength(5);
  });
});

describe("sumHours", () => {
  it("sums values present in the map and treats missing as zero", () => {
    const hours = { "2026-05-01": 4, "2026-05-02": 7 };
    expect(
      sumHours(["2026-05-01", "2026-05-02", "2026-05-03"], hours),
    ).toBe(11);
  });

  it("returns 0 for an empty list", () => {
    expect(sumHours([], {})).toBe(0);
  });
});

describe("formatCAD / formatMonthLabel", () => {
  it("formats CAD currency with $ and grouping", () => {
    expect(formatCAD(1100)).toMatch(/\$1,100\.00/);
  });

  it("formats month labels", () => {
    expect(formatMonthLabel(2026, 5)).toBe("May 2026");
  });
});
