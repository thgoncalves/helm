/**
 * Contract pacing — TypeScript port of `scripts/pacing_calc.py`.
 *
 * The Python module is the source of truth (it has the spec written
 * out in the docstring and a runnable test table). This file mirrors
 * it 1:1 so the running app and the offline calculator never drift.
 *
 * Formula:
 *
 *     net_billable_days = base − customs − vacations − logged_days
 *     remaining_hours   = total_contract_hours − logged_hours
 *     pace              = remaining_hours / net_billable_days
 *
 * Critical invariants (any change to this file MUST keep these true):
 *
 *   - Logging exactly the current pace on one day keeps pace flat
 *     (numerator drops by `pace`, denominator drops by 1).
 *   - Logging > pace drops pace (catch-up).
 *   - Logging < pace raises pace (debt).
 *   - Stat holidays are informational only — already excluded from
 *     `baseBillableDays`, so they don't appear in the formula.
 *
 * See `apps/web/tests/pacing.test.ts` for the full table of cases.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PacingResult {
  baseBillableDays: number;
  /** Informational only — never feeds the formula. */
  statHolidaysInWindow: number;
  customHolidays: number;
  vacationDays: number;
  loggedDays: number;
  loggedHours: number;
  netBillableDays: number;
  totalContractHours: number;
  remainingHours: number;
  /** Unrounded — useful for assertions and downstream math. */
  pace: number;
  /** Rounded to 2 decimal places for the UI. */
  displayedPace: number;
}

export class PacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PacingError";
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export interface PacingInputs {
  totalContractHours: number;
  baseBillableDays: number;
  customHolidays?: number;
  vacationDays?: number;
  loggedDays?: number;
  loggedHours?: number;
  /** Informational only; surfaced in the result but not used in math. */
  statHolidaysInWindow?: number;
}

/**
 * Compute the pacing audit, or null when the contract is fully
 * consumed (no future days to spread over).
 *
 * Throws PacingError when inputs are mutually inconsistent.
 */
export function computePace(inputs: PacingInputs): PacingResult | null {
  const {
    totalContractHours,
    baseBillableDays,
    customHolidays = 0,
    vacationDays = 0,
    loggedDays = 0,
    loggedHours = 0,
    statHolidaysInWindow = 0,
  } = inputs;

  if (baseBillableDays < 0) {
    throw new PacingError(
      `baseBillableDays must be ≥ 0; got ${baseBillableDays}`,
    );
  }
  for (const [name, value] of [
    ["customHolidays", customHolidays],
    ["vacationDays", vacationDays],
    ["loggedDays", loggedDays],
  ] as const) {
    if (value < 0) throw new PacingError(`${name} must be ≥ 0; got ${value}`);
  }
  if (loggedHours < 0) {
    throw new PacingError(`loggedHours must be ≥ 0; got ${loggedHours}`);
  }
  if (totalContractHours < 0) {
    throw new PacingError(
      `totalContractHours must be ≥ 0; got ${totalContractHours}`,
    );
  }

  const netBillableDays =
    baseBillableDays - customHolidays - vacationDays - loggedDays;
  if (netBillableDays < 0) {
    throw new PacingError(
      `More days consumed than the contract base allows: ` +
        `base=${baseBillableDays} - customs=${customHolidays} ` +
        `- vacations=${vacationDays} - logged=${loggedDays} ` +
        `= ${netBillableDays}`,
    );
  }
  if (netBillableDays === 0) {
    // Caller renders "contract complete" or similar.
    return null;
  }

  const rawRemaining = totalContractHours - loggedHours;
  // Over-billed: pin to zero rather than throwing — the UI still wants
  // the audit fields.
  const remainingHours = rawRemaining < 0 ? 0 : rawRemaining;
  const pace = remainingHours / netBillableDays;
  const displayedPace = Math.round(pace * 100) / 100;

  return {
    baseBillableDays,
    statHolidaysInWindow,
    customHolidays,
    vacationDays,
    loggedDays,
    loggedHours,
    netBillableDays,
    totalContractHours,
    remainingHours,
    pace,
    displayedPace,
  };
}
