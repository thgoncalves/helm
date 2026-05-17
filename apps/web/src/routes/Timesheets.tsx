/**
 * Timesheets page.
 *
 * Layout (matches the mock):
 *   ┌ Header (Helm + nav + sign-out) ──────────────────────────────────────┐
 *   │                                                                      │
 *   │  Timesheets                            [Export PDF] [Submit Timesheet]│
 *   │                                                                      │
 *   │  Client: [▼]  Hourly Rate: $X  Frequency: …  Remaining: $… / … hrs  │
 *   │                                                                      │
 *   │  ◀ Previous              May 2026                            Next ▶ │
 *   │                                                                      │
 *   │  ┌────────┬──── Mon ─── Tue ─── Wed ─── Thu ─── Fri ─── Sat ─── Sun ┐│
 *   │  │ 16 hrs │   4      4      4      0      4      0      0          ││
 *   │  │ $1,600 │  Apr 27  Apr 28 Apr 29  Apr 30   1      2      3       ││
 *   │  └────────┴───────────────────────────────────────────────────────┘  │
 *   │  …                                                                    │
 *   │                                                                       │
 *   │  Month Total                          Period: May 01 - May 31, 2026   │
 *   │  Total Hours: 11    Total Amount: $1,100.00                           │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Data flow:
 *   GET /business/clients/  → populate the client dropdown
 *   GET /business/time-entries (client_id, calendar window) → seed the grid
 *   GET /business/timesheets/summary → header rate / remaining / month total
 *   PUT /business/time-entries/bulk → auto-save on cell blur (latest wins)
 *   GET /business/timesheets/pdf → triggered by the Export PDF button
 *
 * Out-of-month cells are read-only (greyed) but still contribute to the
 * weekly subtotal so weekly billing makes sense for first/last rows.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import type {
  ClientRead,
  SubmitTimesheetResponse,
  TimeEntryRead,
  TimesheetSummary,
} from "@/types/api";
import {
  buildCalendar,
  endOfMonth,
  formatCAD,
  formatMonthLabel,
  sumHours,
  toIsoDate,
} from "@/lib/timesheet";
import {
  albertaHolidays,
  buildHolidayLookup,
  findVacation,
  parseCustomHolidays,
  parseVacations,
} from "@/lib/holidays";
import { computePace } from "@/lib/pacing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AppHeader } from "@/components/AppHeader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isNaN(n) ? 0 : n;
}

function todayIso(): string {
  return toIsoDate(new Date());
}

// Tiny date helpers for the pacing walker — kept here (rather than in
// @/lib/timesheet) because they're internal to the page's per-day pass.
function isoToDayNumber(iso: string): number {
  return Math.round(
    Date.UTC(
      Number(iso.slice(0, 4)),
      Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10)),
    ) / 86_400_000,
  );
}
function dayNumberFromIso(n: number): string {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function dowOf(iso: string): number {
  // Mon=0..Sun=6 so Sat/Sun become 5/6.
  const d = new Date(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
  return (d.getDay() + 6) % 7;
}
function isInVacationPeriod(
  iso: string,
  vacations: { start: string; end: string }[],
): boolean {
  for (const v of vacations) {
    if (iso >= v.start && iso <= v.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Timesheets() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Selected client.
  const [clientId, setClientId] = useState<string | null>(null);

  // Selected month (1-indexed).
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Local hours map for the visible calendar window. Keys are YYYY-MM-DD.
  const [hoursByDate, setHoursByDate] = useState<Record<string, number>>({});

  // Calendar weeks for the current view.
  const weeks = useMemo(() => buildCalendar(year, month), [year, month]);
  const windowStart = weeks[0]?.cells[0]?.iso;
  const windowEnd = weeks[weeks.length - 1]?.cells[6]?.iso;

  // Period bounds for the bulk save (calendar month, not visible window —
  // see header doc for why weekly subtotals span the row but the period is
  // still the calendar month).
  const periodStartIso = `${year}-${String(month).padStart(2, "0")}-01`;
  const periodEndIso = toIsoDate(endOfMonth(year, month));

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  const { data: clients } = useQuery<ClientRead[]>({
    queryKey: ["clients", "active"],
    queryFn: () => apiFetch<ClientRead[]>("/business/clients/"),
    staleTime: 60_000,
  });

  // Auto-pick the first active client on first load.
  useEffect(() => {
    if (clientId === null && clients && clients.length > 0) {
      const first = clients[0];
      if (first) setClientId(first.id);
    }
  }, [clientId, clients]);

  const selectedClient = clients?.find((c) => c.id === clientId) ?? null;

  const entriesQuery = useQuery<TimeEntryRead[]>({
    queryKey: ["time-entries", clientId, windowStart, windowEnd],
    queryFn: () =>
      apiFetch<TimeEntryRead[]>(
        `/business/time-entries/?client_id=${clientId}&start=${windowStart}&end=${windowEnd}`,
      ),
    enabled: Boolean(clientId && windowStart && windowEnd),
  });

  // Re-seed local state whenever the API entries change (client/month change).
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const entry of entriesQuery.data ?? []) {
      next[entry.work_date] = num(entry.hours);
    }
    setHoursByDate(next);
  }, [entriesQuery.data]);

  // Holidays + vacations come from the settings table as JSON strings.
  // We compute Alberta stat holidays client-side so the data stays small.
  const settingsQuery = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => apiFetch<Record<string, string>>("/business/settings/"),
    staleTime: 5 * 60_000,
  });
  const customHolidays = useMemo(
    () => parseCustomHolidays(settingsQuery.data?.["custom_holidays"]),
    [settingsQuery.data],
  );
  const vacations = useMemo(
    () => parseVacations(settingsQuery.data?.["vacations"]),
    [settingsQuery.data],
  );
  const holidayLookup = useMemo(
    () =>
      buildHolidayLookup(
        customHolidays,
        windowStart && windowEnd
          ? { startIso: windowStart, endIso: windowEnd }
          : null,
      ),
    [customHolidays, windowStart, windowEnd],
  );

  const summaryQuery = useQuery<TimesheetSummary>({
    queryKey: ["timesheet-summary", clientId, periodStartIso, periodEndIso],
    queryFn: () =>
      apiFetch<TimesheetSummary>(
        `/business/timesheets/summary?client_id=${clientId}&start=${periodStartIso}&end=${periodEndIso}`,
      ),
    enabled: Boolean(clientId),
  });

  // ---------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------

  const saveMutation = useMutation<TimeEntryRead[], ApiError, void>({
    mutationFn: async () => {
      if (!clientId) throw new Error("No client selected");
      // Send only entries that fall within [periodStart, periodEnd]; any
      // out-of-month dates the user managed to type into belong to a
      // different month's timesheet.
      const entries = Object.entries(hoursByDate)
        .filter(([iso]) => iso >= periodStartIso && iso <= periodEndIso)
        .map(([iso, hours]) => ({ work_date: iso, hours: String(hours) }));
      return apiFetch<TimeEntryRead[]>("/business/time-entries/bulk", {
        method: "PUT",
        body: JSON.stringify({
          client_id: clientId,
          period_start: periodStartIso,
          period_end: periodEndIso,
          entries,
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["timesheet-summary", clientId],
      });
    },
  });

  // ---------------------------------------------------------------------
  // Cell handlers
  // ---------------------------------------------------------------------

  function handleCellChange(iso: string, raw: string) {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    const n = cleaned === "" ? 0 : Number(cleaned);
    if (Number.isNaN(n)) return;
    setHoursByDate((prev) => ({ ...prev, [iso]: n }));
  }

  function handleCellBlur() {
    if (!clientId) return;
    saveMutation.mutate();
  }

  // ---------------------------------------------------------------------
  // PDF export + Submit (stub)
  // ---------------------------------------------------------------------

  const [pdfError, setPdfError] = useState<string | null>(null);

  async function handleExportPdf() {
    if (!clientId || !selectedClient) return;
    setPdfError(null);
    try {
      const blob = await apiFetchBlob(
        `/business/timesheets/pdf?client_id=${clientId}&year=${year}&month=${month}`,
      );
      const url = URL.createObjectURL(blob);
      const safeName = selectedClient.name.replace(/[^\w-]+/g, "_");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${year}${String(month).padStart(2, "0")}-001 Timesheet ${safeName}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : err instanceof Error
            ? err.message
            : "Unknown error";
      setPdfError(msg);
    }
  }

  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitMutation = useMutation<SubmitTimesheetResponse, ApiError, void>({
    mutationFn: async () => {
      if (!clientId) throw new Error("No client selected");
      return apiFetch<SubmitTimesheetResponse>("/business/timesheets/submit", {
        method: "POST",
        body: JSON.stringify({ client_id: clientId, year, month }),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({
        queryKey: ["time-entries", clientId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["timesheet-summary", clientId],
      });
      navigate(`/invoices/${result.invoice.id}`);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : String(err);
      setSubmitError(msg);
    },
  });

  async function handleSubmitTimesheet() {
    if (!clientId) return;
    setSubmitError(null);
    // Save any pending edits first so they're included in the invoice.
    try {
      await saveMutation.mutateAsync();
    } catch {
      // saveMutation.isError surfaces this below; don't proceed.
      return;
    }
    submitMutation.mutate();
  }

  // ---------------------------------------------------------------------
  // Derived header values
  // ---------------------------------------------------------------------

  const summary = summaryQuery.data;
  const rate = num(summary?.hourly_rate);
  const monthTotalHours = (() => {
    let total = 0;
    for (let day = 1; day <= endOfMonth(year, month).getDate(); day++) {
      const iso = toIsoDate(new Date(year, month - 1, day));
      total += hoursByDate[iso] ?? 0;
    }
    return total;
  })();
  const monthTotalAmount = monthTotalHours * rate;

  function shiftMonth(delta: number) {
    let nm = month + delta;
    let ny = year;
    if (nm < 1) {
      nm = 12;
      ny -= 1;
    } else if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    setMonth(nm);
    setYear(ny);
  }

  const monthLabel = formatMonthLabel(year, month);
  const periodLabel = (() => {
    const startStr = new Date(year, month - 1, 1).toLocaleDateString("en-CA", {
      month: "short",
      day: "2-digit",
    });
    const endStr = endOfMonth(year, month).toLocaleDateString("en-CA", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });
    const freq = selectedClient?.timesheet_frequency
      ? capitalise(selectedClient.timesheet_frequency)
      : "Monthly";
    return `Period: ${startStr} - ${endStr} (${freq})`;
  })();

  const today = todayIso();

  // ---------------------------------------------------------------------
  // Pacing widget — "Expected hours a day to fulfill contract"
  //
  // Dynamic: takes contract_remaining_hours from the summary (which
  // includes every saved time entry across the whole contract) and
  // subtracts the **unsaved** delta the user has typed into the visible
  // grid but not yet blurred. The number updates on every keystroke.
  //
  // Window is [today, contract_end_date]. Hidden when contract dates
  // aren't set.
  // ---------------------------------------------------------------------

  const contractStartDate = selectedClient?.contract_start_date ?? null;
  const contractEndDate = selectedClient?.contract_end_date ?? null;

  // Fetch every saved time entry across the whole contract window so we
  // can derive worked/forecasted counts. Falls back to no query when
  // the contract isn't fully defined.
  const pacingEntriesQuery = useQuery<TimeEntryRead[]>({
    queryKey: [
      "time-entries-pacing",
      clientId,
      contractStartDate,
      contractEndDate,
    ],
    queryFn: () =>
      apiFetch<TimeEntryRead[]>(
        `/business/time-entries/?client_id=${clientId}&start=${contractStartDate}&end=${contractEndDate}`,
      ),
    enabled: Boolean(clientId && contractStartDate && contractEndDate),
  });

  // Single pass over the contract window: count weekdays, stat holidays,
  // deductible customs/vacations, and roll up logged hours/days. All the
  // pacing inputs derive from this so the math is consistent.
  const pacingCounts = useMemo(() => {
    if (!contractStartDate || !contractEndDate) return null;
    if (contractEndDate < contractStartDate) return null;

    // Stat holiday set for every year touched by the window.
    const statSet = new Set<string>();
    const startYear = Number(contractStartDate.slice(0, 4));
    const endYear = Number(contractEndDate.slice(0, 4));
    for (let y = startYear; y <= endYear; y++) {
      for (const h of albertaHolidays(y)) statSet.add(h.date);
    }

    // Custom holiday set + per-period vacation flattening, both
    // pre-filtered to the contract window.
    const customSet = new Set(
      customHolidays
        .filter((h) => h.date >= contractStartDate && h.date <= contractEndDate)
        .map((h) => h.date),
    );

    // Effective logged-by-date: server entries + local overrides, both
    // clamped to the contract window so pre-contract / post-contract
    // entries don't pollute the math.
    const loggedByDate: Record<string, number> = {};
    for (const e of pacingEntriesQuery.data ?? []) {
      if (
        e.work_date >= contractStartDate &&
        e.work_date <= contractEndDate &&
        num(e.hours) > 0
      ) {
        loggedByDate[e.work_date] = num(e.hours);
      }
    }
    for (const [iso, hours] of Object.entries(hoursByDate)) {
      if (iso < contractStartDate || iso > contractEndDate) continue;
      if (hours > 0) loggedByDate[iso] = hours;
      else delete loggedByDate[iso];
    }

    // Walk every day in the window in a single pass.
    let weekdays = 0;
    let statsInWindow = 0;
    let customsCount = 0;
    const vacationDayIsos = new Set<string>();

    const startN = isoToDayNumber(contractStartDate);
    const endN = isoToDayNumber(contractEndDate);
    for (let n = startN; n <= endN; n++) {
      const iso = dayNumberFromIso(n);
      const dow = dowOf(iso);
      if (dow >= 5) continue; // Sat/Sun
      weekdays++;
      const isStat = statSet.has(iso);
      if (isStat) statsInWindow++;
      // Customs/vacations are deductions only when NOT also a stat
      // holiday (stats already aren't in the base, so deducting again
      // would double-count).
      if (!isStat) {
        if (customSet.has(iso)) customsCount++;
        else if (isInVacationPeriod(iso, vacations)) vacationDayIsos.add(iso);
      }
    }

    // Until we add an editable client field for the contract's
    // "promised billable days", derive it the obvious way: weekdays
    // minus stats. The Python spec calls this `base_billable_days`.
    const baseBillableDays = weekdays - statsInWindow;

    const loggedDays = Object.keys(loggedByDate).length;
    const loggedHours = Object.values(loggedByDate).reduce(
      (a, b) => a + b,
      0,
    );

    return {
      weekdays,
      statHolidaysInWindow: statsInWindow,
      baseBillableDays,
      customHolidays: customsCount,
      vacationDays: vacationDayIsos.size,
      loggedDays,
      loggedHours,
    };
  }, [
    contractStartDate,
    contractEndDate,
    customHolidays,
    vacations,
    pacingEntriesQuery.data,
    hoursByDate,
  ]);

  // Total contract hours come from contract_value / rate. We keep the
  // division in JS rather than relying on the API's quantised value so
  // the math matches what the user expects to the last cent.
  const totalContractHours = useMemo(() => {
    if (rate <= 0) return 0;
    const v = num(selectedClient?.contract_value);
    return v > 0 ? v / rate : 0;
  }, [rate, selectedClient]);

  const pacingResult = useMemo(() => {
    if (!pacingCounts || totalContractHours <= 0) return null;
    try {
      return computePace({
        totalContractHours,
        baseBillableDays: pacingCounts.baseBillableDays,
        customHolidays: pacingCounts.customHolidays,
        vacationDays: pacingCounts.vacationDays,
        loggedDays: pacingCounts.loggedDays,
        loggedHours: pacingCounts.loggedHours,
        statHolidaysInWindow: pacingCounts.statHolidaysInWindow,
      });
    } catch {
      // Invalid inputs (e.g. over-consumed days). UI just hides the
      // widget rather than surfacing the validation error.
      return null;
    }
  }, [pacingCounts, totalContractHours]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Page title + actions */}
        <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Timesheets</h2>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleExportPdf} disabled={!clientId}>
              Export PDF
            </Button>
            <Button
              onClick={() => {
                void handleSubmitTimesheet();
              }}
              disabled={!clientId || submitMutation.isPending}
            >
              {submitMutation.isPending ? "Submitting…" : "Submit Timesheet"}
            </Button>
          </div>
        </div>

        {pdfError && (
          <p className="mb-3 text-sm text-destructive">PDF export failed: {pdfError}</p>
        )}
        {submitError && (
          <p className="mb-3 text-sm text-destructive">
            Submit failed: {submitError}
          </p>
        )}

        {/* Client + contract summary row */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border bg-card px-4 py-3">
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label htmlFor="client" className="text-sm font-medium">
              Client:
            </label>
            <select
              id="client"
              className={`${SELECT_CLASSES} w-full sm:w-auto sm:min-w-[260px]`}
              value={clientId ?? ""}
              onChange={(e) => setClientId(e.target.value || null)}
            >
              {!clientId && <option value="">Select a client…</option>}
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.hourly_rate ? ` (${formatCAD(num(c.hourly_rate))}/hr)` : ""}
                </option>
              ))}
            </select>
          </div>

          {selectedClient &&
            (() => {
              // Actual / Remaining come from the same in-window logged
              // totals the pacing math uses, keeping every number in the
              // panel consistent with every other number. Falls back to
              // the summary endpoint when we don't have contract dates.
              const actualHours = pacingCounts
                ? pacingCounts.loggedHours
                : num(summary?.contract_hours_logged);
              const actualAmount = actualHours * rate;
              const remainingHours =
                totalContractHours > 0
                  ? totalContractHours - actualHours
                  : num(summary?.contract_remaining_hours);
              const remainingAmount = Math.max(
                0,
                num(selectedClient.contract_value) - actualAmount,
              );
              const showFinancials =
                summary?.contract_remaining_amount !== null &&
                summary?.contract_remaining_amount !== undefined;

              const livePace = pacingResult ?? null;
              const isBehind = livePace ? livePace.displayedPace > 10 : false;
              const paceColour = isBehind
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400";

              return (
                <div className="basis-full text-sm">
                  {/* Hero metric row: Expected · Actual · Remaining */}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                    {livePace && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-muted-foreground">
                          Expected:
                        </span>
                        <span className={`font-bold ${paceColour}`}>
                          {livePace.displayedPace.toFixed(2)} h/day
                        </span>
                        {isBehind && (
                          <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                            behind pace
                          </span>
                        )}
                      </span>
                    )}
                    {showFinancials && (
                      <>
                        <span>
                          <span className="text-muted-foreground">
                            Actual:
                          </span>{" "}
                          <span className="font-semibold">
                            {formatCAD(actualAmount)}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            / {actualHours.toFixed(2)} hrs
                          </span>
                        </span>
                        <span>
                          <span className="text-muted-foreground">
                            Remaining:
                          </span>{" "}
                          <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                            {formatCAD(remainingAmount)}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            / {remainingHours.toFixed(2)} hrs
                          </span>
                        </span>
                      </>
                    )}
                  </div>

                  {/* Breakdown row: Worked · Forecasted · deductions */}
                  {livePace && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium text-foreground">
                          Worked
                        </span>
                        {livePace.loggedDays} day
                        {livePace.loggedDays !== 1 ? "s" : ""} (
                        {livePace.loggedHours}h)
                      </span>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium text-foreground">
                            Forecasted
                          </span>
                          {livePace.netBillableDays} day
                          {livePace.netBillableDays !== 1 ? "s" : ""}
                        </span>
                        <span className="opacity-60">
                          ({livePace.baseBillableDays} base
                          {livePace.loggedDays > 0
                            ? ` − ${livePace.loggedDays} logged`
                            : ""}
                          {livePace.vacationDays > 0
                            ? ` − ${livePace.vacationDays} vacation`
                            : ""}
                          {livePace.customHolidays > 0
                            ? ` − ${livePace.customHolidays} custom holiday${livePace.customHolidays !== 1 ? "s" : ""}`
                            : ""}
                          )
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              );
            })()}
        </div>

        {/* Month nav */}
        <div className="mb-3 flex items-center justify-between">
          <Button variant="outline" onClick={() => shiftMonth(-1)}>
            ◀ Previous
          </Button>
          <h3 className="text-lg font-semibold">{monthLabel}</h3>
          <Button variant="outline" onClick={() => shiftMonth(1)}>
            Next ▶
          </Button>
        </div>

        {/* Calendar grid */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="border-b border-r px-3 py-2 text-left font-semibold">
                      Subtotal
                    </th>
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
                      (label) => (
                        <th
                          key={label}
                          className="border-b px-3 py-2 text-left font-semibold"
                        >
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((week, wi) => {
                    const weekHours = sumHours(
                      week.cells.map((c) => c.iso),
                      hoursByDate,
                    );
                    const weekAmount = weekHours * rate;
                    return (
                      <tr key={week.cells[0]?.iso ?? `week-${wi}`}>
                        <td className="border-r bg-muted/50 px-3 py-3 align-top">
                          <div className="font-bold text-foreground">
                            {weekHours} hrs
                          </div>
                          <div className="mt-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            {formatCAD(weekAmount)}
                          </div>
                        </td>
                        {week.cells.map((cell) => {
                          const value = hoursByDate[cell.iso] ?? 0;
                          const isToday = cell.iso === today;
                          const holiday = holidayLookup[cell.iso] ?? null;
                          const vacation = findVacation(cell.iso, vacations);
                          // Priority: out-of-month > holiday > vacation > weekend.
                          const cellBg = !cell.inMonth
                            ? "bg-muted/40 text-muted-foreground"
                            : holiday
                              ? "bg-rose-100/70 dark:bg-rose-950/40"
                              : vacation
                                ? "bg-amber-100/70 dark:bg-amber-950/40"
                                : cell.isWeekend
                                  ? "bg-sky-100/60 dark:bg-sky-950/30"
                                  : "";
                          const title =
                            holiday?.name ??
                            vacation?.label ??
                            (cell.isWeekend ? "Weekend" : undefined);
                          return (
                            <td
                              key={cell.iso}
                              className={`border-b border-l align-top ${cellBg}`}
                              title={title}
                            >
                              <div className="flex flex-col gap-1 px-2 py-2">
                                <div
                                  className={
                                    "flex items-baseline justify-between gap-1 text-xs " +
                                    (isToday
                                      ? "font-bold text-primary"
                                      : "text-muted-foreground")
                                  }
                                >
                                  {holiday && cell.inMonth && (
                                    <span
                                      className="truncate text-[10px] font-semibold text-rose-700 dark:text-rose-300"
                                      aria-label={`Holiday: ${holiday.name}`}
                                    >
                                      {holiday.name}
                                    </span>
                                  )}
                                  {!holiday && vacation && cell.inMonth && (
                                    <span
                                      className="truncate text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                                      aria-label={`Vacation: ${vacation.label}`}
                                    >
                                      {vacation.label}
                                    </span>
                                  )}
                                  <span className="ml-auto">
                                    {cell.dayOfMonth === 1 || !cell.inMonth
                                      ? cell.date.toLocaleDateString("en-CA", {
                                          month: "short",
                                          day: "numeric",
                                        })
                                      : cell.dayOfMonth}
                                  </span>
                                </div>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={value === 0 ? "0" : String(value)}
                                  onChange={(e) =>
                                    handleCellChange(cell.iso, e.target.value)
                                  }
                                  onBlur={handleCellBlur}
                                  disabled={!cell.inMonth || !clientId}
                                  className={
                                    "h-10 w-full rounded-md border border-input bg-background px-2 py-1 text-right text-sm text-foreground sm:h-9 " +
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                                    (isToday ? "ring-2 ring-ring " : "") +
                                    (cell.inMonth
                                      ? ""
                                      : "cursor-not-allowed bg-muted/30 text-muted-foreground ")
                                  }
                                />
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Month total */}
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h4 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
                Month Total
              </h4>
              <p className="mt-1 text-base">
                <span className="font-semibold">
                  Total Hours: {monthTotalHours}
                </span>{" "}
                |{" "}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  Total Amount: {formatCAD(monthTotalAmount)}
                </span>
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{periodLabel}</p>
          </CardContent>
        </Card>

        {saveMutation.isError && (
          <p className="mt-3 text-sm text-destructive">
            Save failed:{" "}
            {saveMutation.error instanceof ApiError
              ? `Server error ${saveMutation.error.status}`
              : String(saveMutation.error)}
          </p>
        )}
      </main>
    </div>
  );
}

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
