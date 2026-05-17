/**
 * Pacing helpers for the Timesheets page.
 *
 * Computes how many hours per business day are needed to exhaust a contract's
 * remaining hours before the contract end date, taking Alberta stat holidays
 * and user-defined vacation periods into account.
 *
 * All date arithmetic is done in local-calendar space (string ISO dates) so
 * the results are independent of the user's timezone.
 */

import type { HolidayEntry, VacationPeriod } from "@/lib/holidays";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusinessDayBreakdown {
  /** Total Mon–Fri days in [fromIso, toIso] inclusive. */
  totalBusinessDays: number;
  /** Stat/custom holidays that fall on a business day in the window. */
  holidayDaysDeducted: number;
  /** Vacation-period days that fall on a business day (not already a holiday). */
  vacationDaysDeducted: number;
  /** Business days actually available: totalBusinessDays − holidays − vacations. */
  remaining: number;
}

export interface PacingResult {
  /** Required hours per available business day (may be Infinity if remaining=0). */
  hoursPerDay: number;
  /** Mon–Fri count in the window, before any deductions. */
  totalBusinessDays: number;
  /** Available business days (Mon–Fri minus holidays minus vacations). */
  businessDaysRemaining: number;
  /** Stat/custom holidays deducted. */
  holidayDaysDeducted: number;
  /** Vacation days deducted. */
  vacationDaysDeducted: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO date string to an integer day number (days since epoch).
 * We use this only for iteration; results are not timezone-sensitive because
 * we work in calendar-date strings throughout.
 */
function isoToDayNumber(iso: string): number {
  // Parse as UTC noon to avoid any DST boundary surprises when converting back.
  return Math.round(Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  ) / 86_400_000);
}

function dayNumberToIso(n: number): string {
  const d = new Date(n * 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Return the day-of-week for an ISO date: 0=Mon … 6=Sun (matches getUTCDay offset). */
function dowOfIso(iso: string): number {
  const d = new Date(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
  // getDay(): 0=Sun…6=Sat → shift so 0=Mon…6=Sun
  return (d.getDay() + 6) % 7;
}

function isBusinessDay(iso: string): boolean {
  const dow = dowOfIso(iso);
  return dow < 5; // Mon–Fri
}

function isInVacation(iso: string, vacations: VacationPeriod[]): boolean {
  for (const v of vacations) {
    if (iso >= v.start && iso <= v.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count business days in the inclusive range [fromIso, toIso], then subtract
 * holidays and vacation days.
 *
 * Counting rule: each day is deducted **at most once**. Priority is
 * holiday > vacation, so a day that is both a holiday and inside a
 * vacation range counts as a holiday deduction only.
 *
 * `exemptIsos` lists days that are treated as plain business days even if
 * they fall inside a vacation range — used by Timesheets to exempt
 * Alberta statutory holidays (which are billable by virtue of the
 * hourly rate, so a vacation overlapping one shouldn't reduce capacity).
 *
 * @param fromIso  Start date (YYYY-MM-DD), inclusive.
 * @param toIso    End date (YYYY-MM-DD), inclusive. Must be >= fromIso.
 * @param holidayIsos  Set of ISO dates that are deductible holidays.
 * @param vacations    Vacation periods. Days inside any period are deducted
 *                     unless they're also in `holidayIsos` or `exemptIsos`.
 * @param exemptIsos   Days that suppress both holiday and vacation
 *                     deduction (i.e. count as plain business days).
 */
export function businessDaysBetween(
  fromIso: string,
  toIso: string,
  holidayIsos: Set<string>,
  vacations: VacationPeriod[],
  exemptIsos: Set<string> = new Set(),
  loggedDayIsos: Set<string> = new Set(),
): BusinessDayBreakdown {
  const fromN = isoToDayNumber(fromIso);
  const toN = isoToDayNumber(toIso);

  let totalBusinessDays = 0;
  let holidayDaysDeducted = 0;
  let vacationDaysDeducted = 0;

  for (let n = fromN; n <= toN; n++) {
    const iso = dayNumberToIso(n);
    if (!isBusinessDay(iso)) continue;
    // A day with any logged hours is "consumed" — drop it from the
    // forward-planning pool entirely (the hours it carries are already
    // reflected in the caller's remainingHours number).
    if (loggedDayIsos.has(iso)) continue;
    totalBusinessDays++;
    if (exemptIsos.has(iso)) continue;
    if (holidayIsos.has(iso)) {
      holidayDaysDeducted++;
    } else if (isInVacation(iso, vacations)) {
      vacationDaysDeducted++;
    }
  }

  const remaining = totalBusinessDays - holidayDaysDeducted - vacationDaysDeducted;
  return { totalBusinessDays, holidayDaysDeducted, vacationDaysDeducted, remaining };
}

/**
 * Compute the required hourly pace (hours/available business day) to log
 * ``remainingHours`` of work before ``toIso``.
 *
 * Returns ``null`` when ``toIso < fromIso`` (contract window already ended or
 * inverted dates).
 *
 * When ``remaining`` available business days is 0 (all days are holidays /
 * vacations, or today is the last day), ``hoursPerDay`` is ``Infinity``.
 *
 * @param params.remainingHours  Hours still to be logged.
 * @param params.fromIso         Start of the window (today, typically).
 * @param params.toIso           Contract end date.
 * @param params.holidayIsos     Set of ISO holiday dates in the window.
 * @param params.vacations       Vacation periods to deduct.
 */
export function requiredPace(params: {
  remainingHours: number;
  fromIso: string;
  toIso: string;
  holidayIsos: Set<string>;
  vacations: VacationPeriod[];
  /** Days exempt from both holiday and vacation deduction. */
  exemptIsos?: Set<string>;
  /** Days that already have logged hours — removed from the day pool. */
  loggedDayIsos?: Set<string>;
}): PacingResult | null {
  const {
    remainingHours,
    fromIso,
    toIso,
    holidayIsos,
    vacations,
    exemptIsos,
    loggedDayIsos,
  } = params;

  if (toIso < fromIso) return null;

  const breakdown = businessDaysBetween(
    fromIso,
    toIso,
    holidayIsos,
    vacations,
    exemptIsos,
    loggedDayIsos,
  );
  const {
    totalBusinessDays,
    remaining,
    holidayDaysDeducted,
    vacationDaysDeducted,
  } = breakdown;

  const hoursPerDay = remaining === 0 ? Infinity : remainingHours / remaining;

  return {
    hoursPerDay,
    totalBusinessDays,
    businessDaysRemaining: remaining,
    holidayDaysDeducted,
    vacationDaysDeducted,
  };
}

// Re-export the types from holidays so consumers can import from one place.
export type { HolidayEntry, VacationPeriod };
