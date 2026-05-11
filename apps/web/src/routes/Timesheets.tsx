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
            <Button
              variant="default"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleExportPdf}
              disabled={!clientId}
            >
              Export PDF
            </Button>
            <Button
              variant="default"
              className="bg-blue-600 hover:bg-blue-700 text-white"
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

          {selectedClient && (
            <>
              <div className="text-sm">
                <span className="text-muted-foreground">Hourly Rate:</span>{" "}
                <span className="font-semibold">{formatCAD(rate)}</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Frequency:</span>{" "}
                <span className="font-semibold">
                  {selectedClient.timesheet_frequency
                    ? capitalise(selectedClient.timesheet_frequency)
                    : "Monthly"}
                </span>
              </div>
              {summary?.contract_remaining_amount !== null &&
                summary?.contract_remaining_amount !== undefined && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Remaining:</span>{" "}
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {formatCAD(num(summary.contract_remaining_amount))}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      / {num(summary.contract_remaining_hours).toFixed(2)} hrs
                    </span>
                  </div>
                )}
            </>
          )}
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
                          const cellBg = !cell.inMonth
                            ? "bg-muted/40 text-muted-foreground"
                            : cell.isWeekend
                              ? "bg-muted/30"
                              : "";
                          return (
                            <td
                              key={cell.iso}
                              className={`border-b border-l align-top ${cellBg}`}
                            >
                              <div className="flex flex-col gap-1 px-2 py-2">
                                <div
                                  className={`text-right text-xs ${isToday ? "font-bold text-primary" : "text-muted-foreground"}`}
                                >
                                  {cell.dayOfMonth === 1 || !cell.inMonth
                                    ? cell.date.toLocaleDateString("en-CA", {
                                        month: "short",
                                        day: "numeric",
                                      })
                                    : cell.dayOfMonth}
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
