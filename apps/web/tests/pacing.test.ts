/**
 * Tests for src/lib/pacing.ts.
 *
 * The spec table here is identical to the one in
 * `scripts/pacing_calc.py::_run_spec_table()` so any drift between
 * the TypeScript and Python implementations is caught.
 */
import { describe, it, expect } from "vitest";
import { computePace, PacingError } from "@/lib/pacing";

const HOURS = 1992.03;

describe("computePace — spec table", () => {
  const cases: Array<{
    label: string;
    base: number;
    customs: number;
    vacations: number;
    loggedDays: number;
    loggedHours: number;
    expected: number;
  }> = [
    { label: "Baseline",
      base: 249, customs: 0, vacations: 0, loggedDays: 0, loggedHours: 0,
      expected: 8.0 },
    { label: "10 vacation days, no logging",
      base: 249, customs: 0, vacations: 10, loggedDays: 0, loggedHours: 0,
      expected: 8.33 },
    { label: "1 day logged at 8h",
      base: 249, customs: 0, vacations: 0, loggedDays: 1, loggedHours: 8,
      expected: 8.0 },
    { label: "1 day logged at 10h",
      base: 249, customs: 0, vacations: 0, loggedDays: 1, loggedHours: 10,
      expected: 7.99 },
    { label: "1 day logged at 6h",
      base: 249, customs: 0, vacations: 0, loggedDays: 1, loggedHours: 6,
      expected: 8.01 },
    { label: "10 vacation + 10 days at 10h",
      base: 249, customs: 0, vacations: 10, loggedDays: 10, loggedHours: 100,
      expected: 8.26 },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const result = computePace({
        totalContractHours: HOURS,
        baseBillableDays: c.base,
        customHolidays: c.customs,
        vacationDays: c.vacations,
        loggedDays: c.loggedDays,
        loggedHours: c.loggedHours,
      });
      expect(result).not.toBeNull();
      expect(result!.displayedPace).toBeCloseTo(c.expected, 2);
    });
  }
});

describe("computePace — edge cases", () => {
  it("returns null when net billable days hits zero (fully consumed)", () => {
    const out = computePace({
      totalContractHours: 100,
      baseBillableDays: 5,
      loggedDays: 5,
    });
    expect(out).toBeNull();
  });

  it("throws when more days are consumed than base allows", () => {
    expect(() =>
      computePace({
        totalContractHours: 100,
        baseBillableDays: 5,
        vacationDays: 10,
      }),
    ).toThrow(PacingError);
  });

  it("pins remaining to 0 (and pace to 0) when over-billed", () => {
    const out = computePace({
      totalContractHours: 100,
      baseBillableDays: 10,
      loggedHours: 200,
    });
    expect(out).not.toBeNull();
    expect(out!.remainingHours).toBe(0);
    expect(out!.pace).toBe(0);
  });

  it("stat holidays are informational only — no effect on pace", () => {
    const a = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      statHolidaysInWindow: 0,
    });
    const b = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      statHolidaysInWindow: 99,
    });
    expect(a!.pace).toBe(b!.pace);
  });

  it("rejects negative inputs", () => {
    expect(() =>
      computePace({ totalContractHours: -1, baseBillableDays: 100 }),
    ).toThrow(PacingError);
    expect(() =>
      computePace({
        totalContractHours: 100,
        baseBillableDays: 100,
        loggedHours: -1,
      }),
    ).toThrow(PacingError);
    expect(() =>
      computePace({
        totalContractHours: 100,
        baseBillableDays: -1,
      }),
    ).toThrow(PacingError);
  });
});

describe("computePace — invariants", () => {
  it("logging exactly the target rate on one day keeps pace flat", () => {
    const base = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
    })!;
    const target = base.pace;
    const after = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      loggedDays: 1,
      loggedHours: target,
    })!;
    expect(after.pace).toBeCloseTo(target, 9);
  });

  it("adding vacation days raises pace", () => {
    const noVac = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
    })!;
    const withVac = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      vacationDays: 5,
    })!;
    expect(withVac.pace).toBeGreaterThan(noVac.pace);
  });

  it("logging > target drops pace (catch-up)", () => {
    const base = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
    })!;
    const over = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      loggedDays: 1,
      loggedHours: 10,
    })!;
    expect(over.pace).toBeLessThan(base.pace);
  });

  it("logging < target raises pace (debt)", () => {
    const base = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
    })!;
    const under = computePace({
      totalContractHours: HOURS,
      baseBillableDays: 249,
      loggedDays: 1,
      loggedHours: 6,
    })!;
    expect(under.pace).toBeGreaterThan(base.pace);
  });
});
