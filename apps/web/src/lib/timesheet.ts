/**
 * Pure helpers for the Timesheets page calendar grid.
 *
 * The grid shows weeks Mon → Sun. The first row may straddle into the
 * previous month and the last row into the next month. Out-of-month days
 * are still rendered (so the row totals make sense for weekly billing) but
 * displayed as read-only / greyed in the UI.
 */

/** Format a Date as a local YYYY-MM-DD string. */
export function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse a YYYY-MM-DD string into a local-midnight Date. */
export function fromIsoDate(iso: string): Date {
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Return the Monday of the week containing ``d`` (local time). */
export function startOfWeekMonday(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay(): Sun=0, Mon=1, … Sat=6. Convert to Mon-anchored offset 0..6.
  const dow = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - dow);
  return out;
}

/** Add ``n`` days to ``d``; returns a new Date. */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Last day of the given month (local). */
export function endOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0); // day 0 of next month = last day of this
}

export interface CalendarCell {
  /** YYYY-MM-DD string for use as a key / for the API. */
  iso: string;
  /** Local Date object (midnight). */
  date: Date;
  /** Day of month, 1-31. */
  dayOfMonth: number;
  /** True when this cell belongs to the month being viewed. */
  inMonth: boolean;
  /** True for Saturday/Sunday. */
  isWeekend: boolean;
}

export interface CalendarWeek {
  /** Mon→Sun, length 7. */
  cells: CalendarCell[];
}

/**
 * Build the calendar weeks for ``year``/``month`` (1-indexed month).
 *
 * Always starts on the Monday of the week containing the 1st, and ends
 * with the week containing the last day of the month. So the output is
 * 4–6 weeks depending on the calendar layout.
 */
export function buildCalendar(year: number, month: number): CalendarWeek[] {
  const firstOfMonth = new Date(year, month - 1, 1);
  const lastOfMonth = endOfMonth(year, month);
  let cursor = startOfWeekMonday(firstOfMonth);
  const weeks: CalendarWeek[] = [];
  while (cursor <= lastOfMonth) {
    const cells: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(cursor, i);
      const inMonth = d.getMonth() === month - 1 && d.getFullYear() === year;
      const dow = d.getDay(); // 0=Sun, 6=Sat
      cells.push({
        iso: toIsoDate(d),
        date: d,
        dayOfMonth: d.getDate(),
        inMonth,
        isWeekend: dow === 0 || dow === 6,
      });
    }
    weeks.push({ cells });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** Sum hours for a list of ISO dates given a hours map. */
export function sumHours(
  isoDates: string[],
  hoursByDate: Record<string, number>,
): number {
  return isoDates.reduce((acc, iso) => acc + (hoursByDate[iso] ?? 0), 0);
}

/** Format a number as CAD currency. */
export function formatCAD(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(amount);
}

/** Pretty month label, e.g. "May 2026". */
export function formatMonthLabel(year: number, month: number): string {
  const d = new Date(year, month - 1, 1);
  return d.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}
