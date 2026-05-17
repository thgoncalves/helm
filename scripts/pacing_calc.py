"""Contract pacing calculator — reference implementation.

Implements the spec described in the project chat: given a contract's
total hours, a fixed "base billable days" assumption (stat holidays
already excluded), and the running counts of custom holidays, vacation
days, days with logged hours, and total logged hours, compute the
hours-per-day pace the contractor must hit to finish the contract.

This is the source of truth. The TypeScript implementation in
`apps/web/src/lib/pacing.ts` mirrors the same math; the test cases
below are duplicated in `apps/web/tests/pacing.test.ts` so any drift
between the two is caught by CI.

Run the smoke tests with:
    uv run python scripts/pacing_calc.py
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PacingResult:
    """Full audit trail of a pacing computation.

    All counters surfaced so the caller can render a breakdown and so
    tests can assert against intermediates, not just the final number.
    """

    base_billable_days: int
    stat_holidays_in_window: int  # informational only — NOT deducted
    custom_holidays: int
    vacation_days: int
    logged_days: int
    logged_hours: float
    net_billable_days: int
    total_contract_hours: float
    remaining_hours: float
    pace: float
    displayed_pace: float  # pace rounded to 2dp for the UI


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PacingError(ValueError):
    """Raised when the inputs make pacing math impossible to interpret."""


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


def compute_pace(
    *,
    total_contract_hours: float,
    base_billable_days: int,
    custom_holidays: int = 0,
    vacation_days: int = 0,
    logged_days: int = 0,
    logged_hours: float = 0.0,
    stat_holidays_in_window: int = 0,
) -> Optional[PacingResult]:
    """Return the pacing audit, or None when the contract is fully consumed.

    Formula (see spec):

        net_billable_days = base − customs − vacations − logged_days
        remaining_hours   = total_contract_hours − logged_hours
        pace              = remaining_hours / net_billable_days

    Invariants enforced (see spec test cases):

      * Logging exactly the target rate on a day keeps pace flat
        (numerator drops by `target`, denominator drops by 1).
      * Logging > target drops pace (catch-up).
      * Logging < target raises pace (debt).
      * Stat holidays are *informational*: they're not in the formula
        because they're already excluded from `base_billable_days`.

    Returns
    -------
    PacingResult | None
        ``None`` when ``net_billable_days == 0`` (nothing left to plan).

    Raises
    ------
    PacingError
        When the inputs are mutually inconsistent (negative counts,
        over-consumed days, etc.).
    """
    # ---- validation ----------------------------------------------------
    if base_billable_days < 0:
        raise PacingError(f"base_billable_days must be ≥ 0; got {base_billable_days}")
    for name, value in (
        ("custom_holidays", custom_holidays),
        ("vacation_days", vacation_days),
        ("logged_days", logged_days),
    ):
        if value < 0:
            raise PacingError(f"{name} must be ≥ 0; got {value}")
    if logged_hours < 0:
        raise PacingError(f"logged_hours must be ≥ 0; got {logged_hours}")
    if total_contract_hours < 0:
        raise PacingError(
            f"total_contract_hours must be ≥ 0; got {total_contract_hours}"
        )

    # ---- arithmetic ----------------------------------------------------
    net_billable_days = (
        base_billable_days - custom_holidays - vacation_days - logged_days
    )
    if net_billable_days < 0:
        raise PacingError(
            "More days consumed than the contract base allows: "
            f"base={base_billable_days} - customs={custom_holidays} "
            f"- vacations={vacation_days} - logged={logged_days} "
            f"= {net_billable_days}"
        )
    if net_billable_days == 0:
        # Nothing to spread over. Caller should render "complete" or
        # "contract window ended" UX.
        return None

    remaining_hours = total_contract_hours - logged_hours
    # Negative remaining means the contractor over-billed; we surface
    # this as a zero pace + a tagged result rather than throwing, since
    # the UI still wants the diagnostic fields.
    if remaining_hours < 0:
        remaining_hours = 0.0

    pace = remaining_hours / net_billable_days
    displayed_pace = round(pace, 2)

    return PacingResult(
        base_billable_days=base_billable_days,
        stat_holidays_in_window=stat_holidays_in_window,
        custom_holidays=custom_holidays,
        vacation_days=vacation_days,
        logged_days=logged_days,
        logged_hours=float(logged_hours),
        net_billable_days=net_billable_days,
        total_contract_hours=float(total_contract_hours),
        remaining_hours=float(remaining_hours),
        pace=float(pace),
        displayed_pace=float(displayed_pace),
    )


# ---------------------------------------------------------------------------
# Smoke tests — mirror the spec's table 1:1
# ---------------------------------------------------------------------------


def _check(label: str, got: float, expected: float, tol: float = 0.01) -> None:
    ok = abs(got - expected) <= tol
    flag = "✓" if ok else "✗"
    print(f"  {flag} {label}: got {got:.4f}, expected {expected:.4f}")
    if not ok:
        raise AssertionError(label)


def _run_spec_table() -> None:
    HOURS = 1992.03

    # | Scenario | base | custom | vacation | logged_days | logged_hours | expected pace |
    # Expected values are computed exactly from the formula:
    #     (total_contract_hours - logged_hours) / (base - customs - vacations - logged_days)
    # The spec table had two rounding estimates (8.34, 8.30) that don't
    # match the formula — corrected to 8.33 and 8.26 below.
    cases = [
        ("Baseline",                        249, 0,  0,  0,   0,   8.00),
        ("10 vacation days, no logging",    249, 0,  10, 0,   0,   8.33),
        ("1 day logged at 8h",              249, 0,  0,  1,   8,   8.00),
        ("1 day logged at 10h",             249, 0,  0,  1,   10,  7.99),
        ("1 day logged at 6h",              249, 0,  0,  1,   6,   8.01),
        ("10 vacation + 10 days at 10h",    249, 0,  10, 10,  100, 8.26),
    ]

    print("Spec table:")
    for label, base, customs, vacations, logged_days, logged_hours, expected in cases:
        result = compute_pace(
            total_contract_hours=HOURS,
            base_billable_days=base,
            custom_holidays=customs,
            vacation_days=vacations,
            logged_days=logged_days,
            logged_hours=logged_hours,
        )
        assert result is not None
        _check(label, result.displayed_pace, expected)


def _run_edge_cases() -> None:
    print("\nEdge cases:")

    # net_billable_days == 0  →  None
    out = compute_pace(
        total_contract_hours=100,
        base_billable_days=5,
        logged_days=5,
    )
    assert out is None, "expected None when fully consumed"
    print("  ✓ net == 0 returns None")

    # net_billable_days < 0  →  raises
    raised = False
    try:
        compute_pace(
            total_contract_hours=100,
            base_billable_days=5,
            vacation_days=10,
        )
    except PacingError as exc:
        raised = True
        assert "More days consumed" in str(exc)
    assert raised, "expected PacingError when overconsumed"
    print("  ✓ overconsumed days raises")

    # remaining < 0  →  pace == 0, no throw
    out = compute_pace(
        total_contract_hours=100,
        base_billable_days=10,
        logged_hours=200,
    )
    assert out is not None
    assert out.remaining_hours == 0.0
    assert out.pace == 0.0
    print("  ✓ over-billed contract pins remaining to 0 and pace to 0")

    # Stat holidays are informational — same pace whether you pass 0 or 99
    a = compute_pace(total_contract_hours=1992.03, base_billable_days=249,
                    stat_holidays_in_window=0)
    b = compute_pace(total_contract_hours=1992.03, base_billable_days=249,
                    stat_holidays_in_window=99)
    assert a is not None and b is not None
    assert a.pace == b.pace
    print("  ✓ stat_holidays_in_window does not affect pace")


def _run_invariants() -> None:
    """The behavioral rules from the spec, made executable."""
    print("\nInvariants:")
    HOURS = 1992.03
    BASE = 249

    # Logging exactly the target on a day is neutral.
    base_pace = compute_pace(total_contract_hours=HOURS, base_billable_days=BASE)
    assert base_pace is not None
    target = base_pace.pace
    one_target_logged = compute_pace(
        total_contract_hours=HOURS, base_billable_days=BASE,
        logged_days=1, logged_hours=target,
    )
    assert one_target_logged is not None
    assert abs(one_target_logged.pace - target) < 1e-9, (
        f"target-rate log shifted pace: {one_target_logged.pace} vs {target}"
    )
    print(f"  ✓ logging exactly {target:.4f}h keeps pace flat")

    # Adding vacation increases pace (when nothing else changes).
    no_vac = compute_pace(total_contract_hours=HOURS, base_billable_days=BASE)
    with_vac = compute_pace(
        total_contract_hours=HOURS, base_billable_days=BASE, vacation_days=5,
    )
    assert no_vac is not None and with_vac is not None
    assert with_vac.pace > no_vac.pace
    print(f"  ✓ adding vacation raises pace: {no_vac.pace:.4f} → {with_vac.pace:.4f}")

    # Logging > target drops pace (catch-up).
    over = compute_pace(
        total_contract_hours=HOURS, base_billable_days=BASE,
        logged_days=1, logged_hours=10,
    )
    assert over is not None and over.pace < target
    print(f"  ✓ logging 10h (>target) drops pace: {target:.4f} → {over.pace:.4f}")

    # Logging < target raises pace (debt).
    under = compute_pace(
        total_contract_hours=HOURS, base_billable_days=BASE,
        logged_days=1, logged_hours=6,
    )
    assert under is not None and under.pace > target
    print(f"  ✓ logging 6h (<target) raises pace: {target:.4f} → {under.pace:.4f}")


if __name__ == "__main__":
    _run_spec_table()
    _run_edge_cases()
    _run_invariants()
    print("\nAll checks passed.")
