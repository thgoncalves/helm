/**
 * Tests for src/lib/holidays.ts.
 *
 * Covers the Alberta stat-holiday computation across two distinct years
 * to catch shifts in nth-weekday rules and Easter-derived dates, plus
 * the parse/serialize round-trip for the settings JSON shape.
 */
import { describe, it, expect } from "vitest";
import {
  albertaHolidays,
  buildHolidayLookup,
  findVacation,
  parseCustomHolidays,
  parseVacations,
  serializeCustomHolidays,
  serializeVacations,
} from "@/lib/holidays";

describe("albertaHolidays", () => {
  it("returns 9 holidays in date order", () => {
    const holidays = albertaHolidays(2026);
    expect(holidays).toHaveLength(9);
    const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date));
    expect(holidays).toEqual(sorted);
    for (const h of holidays) expect(h.source).toBe("alberta");
  });

  it("computes 2026 dates correctly", () => {
    const byName = Object.fromEntries(
      albertaHolidays(2026).map((h) => [h.name, h.date]),
    );
    // Fixed
    expect(byName["New Year's Day"]).toBe("2026-01-01");
    expect(byName["Canada Day"]).toBe("2026-07-01");
    expect(byName["Remembrance Day"]).toBe("2026-11-11");
    expect(byName["Christmas Day"]).toBe("2026-12-25");
    // Nth weekday
    expect(byName["Alberta Family Day"]).toBe("2026-02-16"); // 3rd Mon Feb
    expect(byName["Labour Day"]).toBe("2026-09-07"); // 1st Mon Sep
    expect(byName["Thanksgiving Day"]).toBe("2026-10-12"); // 2nd Mon Oct
    // Easter-derived
    expect(byName["Good Friday"]).toBe("2026-04-03");
    // Monday on or before May 24
    expect(byName["Victoria Day"]).toBe("2026-05-18");
  });

  it("computes 2025 dates correctly (different year, distinct shifts)", () => {
    const byName = Object.fromEntries(
      albertaHolidays(2025).map((h) => [h.name, h.date]),
    );
    expect(byName["Alberta Family Day"]).toBe("2025-02-17"); // 3rd Mon Feb
    expect(byName["Good Friday"]).toBe("2025-04-18");
    expect(byName["Victoria Day"]).toBe("2025-05-19");
    expect(byName["Labour Day"]).toBe("2025-09-01");
    expect(byName["Thanksgiving Day"]).toBe("2025-10-13");
  });
});

describe("parseCustomHolidays / serializeCustomHolidays", () => {
  it("round-trips a valid list", () => {
    const list = [
      { date: "2026-08-03", name: "Office Closure", source: "custom" as const },
    ];
    const parsed = parseCustomHolidays(serializeCustomHolidays(list));
    expect(parsed).toEqual(list);
  });

  it("returns [] for missing or malformed JSON", () => {
    expect(parseCustomHolidays(null)).toEqual([]);
    expect(parseCustomHolidays("")).toEqual([]);
    expect(parseCustomHolidays("not json")).toEqual([]);
    expect(parseCustomHolidays("{}")).toEqual([]);
    expect(parseCustomHolidays("[1, 2, 3]")).toEqual([]);
  });
});

describe("parseVacations / serializeVacations", () => {
  it("round-trips a valid list", () => {
    const list = [{ start: "2026-07-01", end: "2026-07-10", label: "BC trip" }];
    expect(parseVacations(serializeVacations(list))).toEqual(list);
  });

  it("returns [] for missing or malformed JSON", () => {
    expect(parseVacations(null)).toEqual([]);
    expect(parseVacations("[{}]")).toEqual([]);
  });
});

describe("buildHolidayLookup", () => {
  it("includes both Alberta and custom entries within the year span", () => {
    const lookup = buildHolidayLookup(
      [{ date: "2026-08-03", name: "Heritage", source: "custom" }],
      { startIso: "2026-01-01", endIso: "2026-12-31" },
    );
    expect(lookup["2026-01-01"]?.name).toBe("New Year's Day");
    expect(lookup["2026-08-03"]?.name).toBe("Heritage");
  });

  it("custom holiday wins when it shares a date with an Alberta entry", () => {
    const lookup = buildHolidayLookup(
      [{ date: "2026-12-25", name: "Family Christmas", source: "custom" }],
      { startIso: "2026-12-01", endIso: "2026-12-31" },
    );
    expect(lookup["2026-12-25"]?.name).toBe("Family Christmas");
    expect(lookup["2026-12-25"]?.source).toBe("custom");
  });
});

describe("findVacation", () => {
  const vacations = [
    { start: "2026-07-15", end: "2026-07-25", label: "Mountain trip" },
  ];

  it("matches inclusive bounds", () => {
    expect(findVacation("2026-07-15", vacations)?.label).toBe("Mountain trip");
    expect(findVacation("2026-07-25", vacations)?.label).toBe("Mountain trip");
    expect(findVacation("2026-07-20", vacations)?.label).toBe("Mountain trip");
  });

  it("returns null outside the range", () => {
    expect(findVacation("2026-07-14", vacations)).toBeNull();
    expect(findVacation("2026-07-26", vacations)).toBeNull();
  });
});
