/**
 * Invoices landing page.
 *
 * Layout (matches the mock):
 *   ┌ Filters ─────────────────────────────────────────────────────────────┐
 *   │ [Fiscal Year ▼]  From: …  To: …  [Apply]  Status: …  Client: …      │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌ Totals by Status ─────────────────────────────────────────────────────┐
 *   │ [Draft $X] [Sent $X] [Overdue $X] [Paid $X] [Total $X]               │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌ Search ──────────────────────────────────────────────────────────────┐
 *   │ [Search...]                                              [Clear]      │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌ Invoice # │ Date │ Due Date │ Client │ Status │ Total ───────────────┐
 *   │ INV-…     │ 01 May 2026 │ 31 May 2026 │ Sulpetro │ Sent │ $3,100.00   │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Filter behaviour:
 *  - Default range = current fiscal year (Apr 1 → Mar 31 next year).
 *  - "This Financial Year" / "Last Financial Year" / "All" presets just
 *    overwrite the from/to fields and re-fetch.
 *  - Status: "All" → no filter; otherwise sent to API as ?status=...
 *    "Overdue" is the only client-side filter (we group it ourselves from
 *    sent + past-due).
 */
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import type {
  ClientRead,
  InvoiceListResponse,
  InvoiceRead,
} from "@/types/api";
import {
  displayStatus,
  fiscalYearEnd,
  fiscalYearForDate,
  fiscalYearStart,
  formatCAD,
  num,
  toIsoDate,
} from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { LoadingBox } from "@/components/LoadingScreen";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

type FyPreset = "this" | "last" | "all" | "custom";

function presetRange(preset: FyPreset, today: Date): {
  from: string | null;
  to: string | null;
} {
  if (preset === "all") return { from: null, to: null };
  if (preset === "this") {
    const fy = fiscalYearForDate(today);
    return {
      from: toIsoDate(fiscalYearStart(fy)),
      to: toIsoDate(fiscalYearEnd(fy)),
    };
  }
  if (preset === "last") {
    const fy = fiscalYearForDate(today) - 1;
    return {
      from: toIsoDate(fiscalYearStart(fy)),
      to: toIsoDate(fiscalYearEnd(fy)),
    };
  }
  return { from: null, to: null };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function Invoices() {
  const navigate = useNavigate();
  const today = useMemo(() => new Date(), []);
  const initial = presetRange("this", today);

  const [preset, setPreset] = useState<FyPreset>("this");
  const [from, setFrom] = useState<string>(initial.from ?? "");
  const [to, setTo] = useState<string>(initial.to ?? "");
  const [status, setStatus] = useState<string>("all");
  const [clientId, setClientId] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  // The actually-applied filter values (changed only on Apply click or on
  // status/client change — those auto-apply since they're already discrete).
  const [appliedFrom, setAppliedFrom] = useState<string>(initial.from ?? "");
  const [appliedTo, setAppliedTo] = useState<string>(initial.to ?? "");

  // Include archived clients so invoices belonging to inactive clients
  // (e.g. CP) still resolve to a name in the table and the filter dropdown.
  const { data: clients } = useQuery<ClientRead[]>({
    queryKey: ["clients", "all"],
    queryFn: () =>
      apiFetch<ClientRead[]>("/business/clients/?include_archived=true"),
    staleTime: 60_000,
  });

  const apiQueryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (appliedFrom) qs.set("from", appliedFrom);
    if (appliedTo) qs.set("to", appliedTo);
    if (status !== "all" && status !== "overdue") qs.set("status", status);
    if (clientId !== "all") qs.set("client_id", clientId);
    return qs.toString();
  }, [appliedFrom, appliedTo, status, clientId]);

  const { data, isLoading, isError, error } = useQuery<InvoiceListResponse>({
    queryKey: ["invoices", apiQueryString],
    queryFn: () =>
      apiFetch<InvoiceListResponse>(
        `/business/invoices/${apiQueryString ? `?${apiQueryString}` : ""}`,
      ),
  });

  function applyPreset(next: FyPreset) {
    setPreset(next);
    const r = presetRange(next, today);
    setFrom(r.from ?? "");
    setTo(r.to ?? "");
    setAppliedFrom(r.from ?? "");
    setAppliedTo(r.to ?? "");
  }

  function applyCustom() {
    setPreset("custom");
    setAppliedFrom(from);
    setAppliedTo(to);
  }

  const filtered: InvoiceRead[] = useMemo(() => {
    let rows = data?.invoices ?? [];
    if (status === "overdue") {
      rows = rows.filter(
        (inv) => displayStatus(inv.status, inv.due_date, today) === "overdue",
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      const clientNameById = new Map(
        (clients ?? []).map((c) => [c.id, c.name.toLowerCase()]),
      );
      rows = rows.filter(
        (inv) =>
          inv.invoice_number.toLowerCase().includes(q) ||
          (clientNameById.get(inv.client_id) ?? "").includes(q) ||
          (inv.notes ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [data, status, today, search, clients]);

  const clientNameById = useMemo(
    () => new Map((clients ?? []).map((c) => [c.id, c.name])),
    [clients],
  );

  // Group invoices by client; sort invoices within each group by issue
  // date (newest first); sort groups alphabetically by client name.
  const grouped = useMemo(() => {
    const byClient = new Map<
      string,
      { clientId: string; clientName: string; invoices: InvoiceRead[]; subtotal: number }
    >();
    for (const inv of filtered) {
      let g = byClient.get(inv.client_id);
      if (!g) {
        g = {
          clientId: inv.client_id,
          clientName: clientNameById.get(inv.client_id) ?? "Unknown client",
          invoices: [],
          subtotal: 0,
        };
        byClient.set(inv.client_id, g);
      }
      g.invoices.push(inv);
      g.subtotal += num(inv.total);
    }
    for (const g of byClient.values()) {
      g.invoices.sort((a, b) => b.issue_date.localeCompare(a.issue_date));
    }
    return Array.from(byClient.values()).sort((a, b) =>
      a.clientName.localeCompare(b.clientName),
    );
  }, [filtered, clientNameById]);

  const grandTotal = useMemo(
    () => grouped.reduce((sum, g) => sum + g.subtotal, 0),
    [grouped],
  );

  const totals = data?.totals_by_status;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Title + New */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Invoices</h2>
          <Button onClick={() => navigate("/invoices/new")}>
            New Invoice
          </Button>
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-4 py-3 text-sm">
          <select
            aria-label="Fiscal year preset"
            value={preset}
            className={`${SELECT_CLASSES} w-44`}
            onChange={(e) => applyPreset(e.target.value as FyPreset)}
          >
            <option value="this">This Financial Year</option>
            <option value="last">Last Financial Year</option>
            <option value="all">All</option>
            <option value="custom">Custom</option>
          </select>

          <label className="ml-2">From:</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPreset("custom");
            }}
            className="h-9 w-40"
          />
          <label>To:</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPreset("custom");
            }}
            className="h-9 w-40"
          />
          <Button variant="outline" size="sm" onClick={applyCustom}>
            Apply
          </Button>

          <label className="ml-3">Status:</label>
          <select
            aria-label="Status filter"
            value={status}
            className={`${SELECT_CLASSES} w-32`}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="overdue">Overdue</option>
            <option value="paid">Paid</option>
          </select>

          <label className="ml-2">Client:</label>
          <select
            aria-label="Client filter"
            value={clientId}
            className={`${SELECT_CLASSES} w-48`}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="all">All</option>
            {(clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active ? "" : " (archived)"}
              </option>
            ))}
          </select>
        </div>

        {/* Totals by Status */}
        <Card className="mb-4">
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Totals by Status</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <TotalCard
                label="Draft"
                value={totals?.draft ?? 0}
                color="text-sky-700"
              />
              <TotalCard
                label="Sent"
                value={totals?.sent ?? 0}
                color="text-amber-600"
              />
              <TotalCard
                label="Overdue"
                value={totals?.overdue ?? 0}
                color="text-red-600"
              />
              <TotalCard
                label="Paid"
                value={totals?.paid ?? 0}
                color="text-emerald-700"
              />
              <TotalCard
                label="Total"
                value={totals?.total ?? 0}
                color="text-foreground"
              />
            </div>
          </CardContent>
        </Card>

        {/* Search */}
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search invoice #, client, or notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search invoices"
          />
          <Button
            variant="outline"
            onClick={() => setSearch("")}
            disabled={!search}
          >
            Clear
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading && (
              <LoadingBox className="m-4" />
            )}
            {isError && (
              <p className="p-6 text-destructive">
                Failed to load invoices:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}
            {!isLoading && !isError && filtered.length === 0 && (
              <p className="p-6 text-muted-foreground">No invoices found.</p>
            )}
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Invoice #</th>
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Due Date</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map((g) => (
                      <Fragment key={g.clientId}>
                        <tr className="border-b border-t bg-muted/60">
                          <th
                            colSpan={4}
                            className="px-4 py-2 text-left text-sm font-semibold"
                          >
                            {g.clientName}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              ({g.invoices.length}{" "}
                              {g.invoices.length === 1
                                ? "invoice"
                                : "invoices"}
                              )
                            </span>
                          </th>
                          <th className="whitespace-nowrap px-4 py-2 text-right text-sm font-semibold">
                            {formatCAD(g.subtotal)}
                          </th>
                        </tr>
                        {g.invoices.map((inv) => {
                          const ds = displayStatus(
                            inv.status,
                            inv.due_date,
                            today,
                          );
                          return (
                            <tr
                              key={inv.id}
                              className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                              onClick={() => navigate(`/invoices/${inv.id}`)}
                            >
                              <td className="whitespace-nowrap px-4 py-2 pl-8 font-medium">
                                {inv.invoice_number}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                                {formatDate(inv.issue_date)}
                              </td>
                              <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                                {formatDate(inv.due_date)}
                              </td>
                              <td className="px-4 py-2">
                                <StatusBadge status={ds} />
                              </td>
                              <td className="whitespace-nowrap px-4 py-2 text-right font-semibold">
                                {formatCAD(num(inv.total))}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                    <tr className="border-t-2 bg-muted">
                      <td
                        colSpan={4}
                        className="px-4 py-3 text-right text-sm font-bold uppercase tracking-wide"
                      >
                        Grand total
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-base font-bold">
                        {formatCAD(grandTotal)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function TotalCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="rounded-md border bg-background px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-xl font-bold ${color}`}>
        {formatCAD(num(value))}
      </p>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: "draft" | "sent" | "overdue" | "paid" | "other";
}) {
  const styles: Record<typeof status, string> = {
    draft:
      "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    sent:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    overdue:
      "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    paid:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    other: "bg-muted text-muted-foreground",
  };
  const labels: Record<typeof status, string> = {
    draft: "Draft",
    sent: "Sent",
    overdue: "Overdue",
    paid: "✓ Paid",
    other: "—",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
