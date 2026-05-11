/**
 * Payments landing page.
 *
 * Matches the brief mock:
 *   - "This Financial Year" preset (Apr 1 → Mar 31 next year) by default.
 *   - From/To pickers + Apply button.
 *   - Search across invoice #, client, reference, notes.
 *   - Table: Date, Invoice #, Client, Gross, Deduction, Net, Method, Reference.
 *   - Click a row to select; Edit + Delete buttons in the footer act on it.
 *   - "Record Payment" button → /payments/new.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type { PaymentListRow } from "@/types/api";
import {
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
import { SignOutButton } from "@/components/SignOutButton";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

type FyPreset = "this" | "last" | "all" | "custom";

function presetRange(
  preset: FyPreset,
  today: Date,
): { from: string | null; to: string | null } {
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

export function Payments() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = useMemo(() => new Date(), []);
  const initial = presetRange("this", today);

  const [preset, setPreset] = useState<FyPreset>("this");
  const [from, setFrom] = useState(initial.from ?? "");
  const [to, setTo] = useState(initial.to ?? "");
  const [appliedFrom, setAppliedFrom] = useState(initial.from ?? "");
  const [appliedTo, setAppliedTo] = useState(initial.to ?? "");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const apiQueryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (appliedFrom) qs.set("from", appliedFrom);
    if (appliedTo) qs.set("to", appliedTo);
    return qs.toString();
  }, [appliedFrom, appliedTo]);

  const { data, isLoading, isError, error } = useQuery<PaymentListRow[]>({
    queryKey: ["payments", apiQueryString],
    queryFn: () =>
      apiFetch<PaymentListRow[]>(
        `/business/payments/${apiQueryString ? `?${apiQueryString}` : ""}`,
      ),
  });

  const deleteMutation = useMutation<void, ApiError, string>({
    mutationFn: async (id) =>
      apiFetch(`/business/payments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
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

  const filtered: PaymentListRow[] = useMemo(() => {
    let rows = data ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (p) =>
          p.invoice_number.toLowerCase().includes(q) ||
          p.client_name.toLowerCase().includes(q) ||
          (p.reference ?? "").toLowerCase().includes(q) ||
          (p.notes ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [data, search]);

  function handleDelete() {
    if (!selectedId) return;
    const row = (data ?? []).find((p) => p.id === selectedId);
    const label = row
      ? `${formatDate(row.payment_date)} · ${row.invoice_number} · ${formatCAD(num(row.amount))}`
      : "this payment";
    if (
      !window.confirm(
        `Delete ${label}?\nThe invoice's status will revert to "sent" if this was the payment that closed it.`,
      )
    ) {
      return;
    }
    deleteMutation.mutate(selectedId);
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-semibold">Helm</h1>
            <nav className="flex gap-4 text-sm">
              <Link
                to="/clients"
                className="text-muted-foreground hover:text-foreground"
              >
                Clients
              </Link>
              <Link
                to="/timesheets"
                className="text-muted-foreground hover:text-foreground"
              >
                Timesheets
              </Link>
              <Link
                to="/invoices"
                className="text-muted-foreground hover:text-foreground"
              >
                Invoices
              </Link>
              <Link to="/payments" className="font-medium">
                Payments
              </Link>
              <Link
                to="/taxes"
                className="text-muted-foreground hover:text-foreground"
              >
                Taxes
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Payments</h2>
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => navigate("/payments/new")}
          >
            Record Payment
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
        </div>

        {/* Search */}
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search invoice #, client, reference, or notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search payments"
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
              <p className="p-6 text-muted-foreground">Loading payments…</p>
            )}
            {isError && (
              <p className="p-6 text-destructive">
                Failed to load payments:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}
            {!isLoading && !isError && filtered.length === 0 && (
              <p className="p-6 text-muted-foreground">No payments found.</p>
            )}
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Invoice #</th>
                      <th className="px-4 py-2 font-semibold">Client</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Gross
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Deduction
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">Net</th>
                      <th className="px-4 py-2 font-semibold">Method</th>
                      <th className="px-4 py-2 font-semibold">Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => {
                      const isSelected = p.id === selectedId;
                      const deduction = num(p.deduction_amount);
                      return (
                        <tr
                          key={p.id}
                          className={
                            "cursor-pointer border-b last:border-0 " +
                            (isSelected
                              ? "bg-sky-50"
                              : "hover:bg-accent/40")
                          }
                          onClick={() => setSelectedId(p.id)}
                          onDoubleClick={() => navigate(`/payments/${p.id}`)}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {formatDate(p.payment_date)}
                          </td>
                          <td className="px-4 py-2 font-medium">
                            {p.invoice_number}
                          </td>
                          <td className="px-4 py-2">{p.client_name}</td>
                          <td className="px-4 py-2 text-right">
                            {formatCAD(num(p.amount))}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {deduction > 0
                              ? formatCAD(deduction)
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {formatCAD(num(p.net))}
                          </td>
                          <td className="px-4 py-2">
                            {p.payment_method ?? "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {p.reference ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action footer */}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() =>
              selectedId && navigate(`/payments/${selectedId}`)
            }
            disabled={!selectedId}
          >
            Edit
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!selectedId || deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </main>
    </div>
  );
}
