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
  /** Available business days (after deducting holidays and vacations). */
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
 * stat/custom holidays and vacation days.
 *
 * @param fromIso  Start date (YYYY-MM-DD), inclusive.
 * @param toIso    End date (YYYY-MM-DD), inclusive. Must be >= fromIso.
 * @param holidayIsos  Set of ISO dates that are holidays.
 * @param vacations    Vacation periods (each day counted only once; holidays
 *                     take priority so a holiday during vacation is counted as
 *                     a holiday, not a vacation day).
 */
export function businessDaysBetween(
  fromIso: string,
  toIso: string,
  holidayIsos: Set<string>,
  vacations: VacationPeriod[],
): BusinessDayBreakdown {
  const fromN = isoToDayNumber(fromIso);
  const toN = isoToDayNumber(toIso);

  let totalBusinessDays = 0;
  let holidayDaysDeducted = 0;
  let vacationDaysDeducted = 0;

  for (let n = fromN; n <= toN; n++) {
    const iso = dayNumberToIso(n);
    if (!isBusinessDay(iso)) continue;
    totalBusinessDays++;
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
}): PacingResult | null {
  const { remainingHours, fromIso, toIso, holidayIsos, vacations } = params;

  if (toIso < fromIso) return null;

  const breakdown = businessDaysBetween(fromIso, toIso, holidayIsos, vacations);
  const { remaining, holidayDaysDeducted, vacationDaysDeducted } = breakdown;

  const hoursPerDay = remaining === 0 ? Infinity : remainingHours / remaining;

  return {
    hoursPerDay,
    businessDaysRemaining: remaining,
    holidayDaysDeducted,
    vacationDaysDeducted,
  };
}

// Re-export the types from holidays so consumers can import from one place.
export type { HolidayEntry, VacationPeriod };
