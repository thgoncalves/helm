/**
 * Alberta statutory holidays + user-defined custom holidays and vacation
 * periods. Used by the Timesheet to color days the user shouldn't be
 * billing for, and by Settings to manage the custom lists.
 *
 * Alberta's 9 statutory holidays (Employment Standards Code):
 *   New Year's Day, Alberta Family Day, Good Friday, Victoria Day,
 *   Canada Day, Labour Day, Thanksgiving Day, Remembrance Day,
 *   Christmas Day.
 * (Boxing Day and Heritage Day are optional in Alberta and intentionally
 * excluded here.)
 *
 * Custom holidays and vacation periods are stored in the settings table
 * under the keys ``custom_holidays`` and ``vacations``, each as a JSON
 * string. The parse helpers here are forgiving: bad/missing JSON yields
 * an empty list rather than throwing.
 */

export interface HolidayEntry {
  /** YYYY-MM-DD. */
  date: string;
  /** Human label shown in the tooltip. */
  name: string;
  /** Source — used by the UI to differentiate "stat" vs custom rows. */
  source: "alberta" | "custom";
}

export interface VacationPeriod {
  /** YYYY-MM-DD inclusive. */
  start: string;
  /** YYYY-MM-DD inclusive. */
  end: string;
  /** Human label shown in the tooltip. */
  label: string;
}

// ---------------------------------------------------------------------------
// Date helpers (kept local so this file has no project imports)
// ---------------------------------------------------------------------------

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Nth occurrence of a given weekday in a month. dow: 0=Sun..6=Sat. */
function nthWeekday(
  year: number,
  monthIdx: number, // 0-indexed
  dow: number,
  n: number,
): Date {
  const first = new Date(year, monthIdx, 1);
  const offset = (dow - first.getDay() + 7) % 7;
  return new Date(year, monthIdx, 1 + offset + (n - 1) * 7);
}

/** Monday on or before a given day-of-month. */
function mondayOnOrBefore(year: number, monthIdx: number, day: number): Date {
  const d = new Date(year, monthIdx, day);
  const offset = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - offset);
  return d;
}

/**
 * Easter Sunday (Gregorian) via Meeus/Jones/Butcher. Good Friday = Easter - 2.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// ---------------------------------------------------------------------------
// Alberta stat holidays
// ---------------------------------------------------------------------------

/**
 * Return the 9 Alberta statutory holidays for a given calendar year, in
 * date order.
 */
export function albertaHolidays(year: number): HolidayEntry[] {
  const easter = easterSunday(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);

  const list: { date: Date; name: string }[] = [
    { date: new Date(year, 0, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), name: "Alberta Family Day" }, // 3rd Mon Feb
    { date: goodFriday, name: "Good Friday" },
    { date: mondayOnOrBefore(year, 4, 24), name: "Victoria Day" }, // Mon on/before May 24
    { date: new Date(year, 6, 1), name: "Canada Day" },
    { date: nthWeekday(year, 8, 1, 1), name: "Labour Day" }, // 1st Mon Sep
    { date: nthWeekday(year, 9, 1, 2), name: "Thanksgiving Day" }, // 2nd Mon Oct
    { date: new Date(year, 10, 11), name: "Remembrance Day" },
    { date: new Date(year, 11, 25), name: "Christmas Day" },
  ];

  return list.map((h) => ({
    date: toIso(h.date),
    name: h.name,
    source: "alberta",
  }));
}

// ---------------------------------------------------------------------------
// Settings persistence helpers
// ---------------------------------------------------------------------------

/** Parse the JSON list stored under settings.custom_holidays. */
export function parseCustomHolidays(json: string | undefined | null): HolidayEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (it): it is { date: string; name: string } =>
          typeof it === "object" &&
          it !== null &&
          typeof (it as { date?: unknown }).date === "string" &&
          typeof (it as { name?: unknown }).name === "string",
      )
      .map((it) => ({ date: it.date, name: it.name, source: "custom" as const }));
  } catch {
    return [];
  }
}

/** Inverse of parseCustomHolidays — drops the source field. */
export function serializeCustomHolidays(entries: HolidayEntry[]): string {
  return JSON.stringify(
    entries.map(({ date, name }) => ({ date, name })),
  );
}

/** Parse the JSON list stored under settings.vacations. */
export function parseVacations(json: string | undefined | null): VacationPeriod[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (it): it is VacationPeriod =>
        typeof it === "object" &&
        it !== null &&
        typeof (it as { start?: unknown }).start === "string" &&
        typeof (it as { end?: unknown }).end === "string" &&
        typeof (it as { label?: unknown }).label === "string",
    );
  } catch {
    return [];
  }
}

export function serializeVacations(periods: VacationPeriod[]): string {
  return JSON.stringify(periods);
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup from ISO date → display label for any cell that should
 * be highlighted as a holiday (Alberta stat OR custom). Spans all years
 * required by the supplied window.
 */
export function buildHolidayLookup(
  customHolidays: HolidayEntry[],
  isoRange: { startIso: string; endIso: string } | null,
): Record<string, HolidayEntry> {
  const map: Record<string, HolidayEntry> = {};
  if (isoRange) {
    const startYear = Number(isoRange.startIso.slice(0, 4));
    const endYear = Number(isoRange.endIso.slice(0, 4));
    for (let y = startYear; y <= endYear; y++) {
      for (const h of albertaHolidays(y)) map[h.date] = h;
    }
  }
  for (const h of customHolidays) map[h.date] = h;
  return map;
}

/** Returns the matching vacation period for ``iso``, if any. */
export function findVacation(
  iso: string,
  vacations: VacationPeriod[],
): VacationPeriod | null {
  for (const v of vacations) {
    if (iso >= v.start && iso <= v.end) return v;
  }
  return null;
}
