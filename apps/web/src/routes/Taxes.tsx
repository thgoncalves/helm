/**
 * Taxes landing page (GST Payments).
 *
 * Layout (matches Image #24):
 *   ┌ KPI Cards ──────────────────────────────────────────────────────────┐
 *   │ GST Unpaid (red) │ Unpaid Income │ Total GST Paid                   │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 *   ┌ Search ─────────────────────────────────────────────────────────────┐
 *   │ Search...                                                     Clear │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 *   ┌ GST Payments table ─────────────────────────────────────────────────┐
 *   │ Date │ Invoices │ Income │ GST Amount │ Method │ Reference          │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 *   Invoices with Unpaid GST
 *   ┌ Search ─────────────────────────────────────────────────────────────┐
 *   │ Invoice # │ Client │ Date │ Total │ GST Amount                      │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 *   [View Invoices] [Edit Payment] [Link Invoices] [Delete Payment]
 *
 * Selection model:
 *   Selecting a row in the upper table enables Edit/Link/Delete/View.
 *   "View Invoices" jumps to the Edit page (which also lists linked
 *   invoices). "Link Invoices" jumps to the Link dialog at
 *   /taxes/:id/link.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  TaxPaymentListRow,
  TaxSummary,
  UnpaidInvoice,
} from "@/types/api";
import { formatCAD, num } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SignOutButton } from "@/components/SignOutButton";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function Taxes() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paymentSearch, setPaymentSearch] = useState("");
  const [unpaidSearch, setUnpaidSearch] = useState("");

  const { data: summary } = useQuery<TaxSummary>({
    queryKey: ["tax-summary"],
    queryFn: () => apiFetch<TaxSummary>("/business/tax-payments/summary"),
  });

  const { data: payments, isLoading, isError, error } = useQuery<
    TaxPaymentListRow[]
  >({
    queryKey: ["tax-payments"],
    queryFn: () =>
      apiFetch<TaxPaymentListRow[]>("/business/tax-payments/"),
  });

  const { data: unpaid } = useQuery<UnpaidInvoice[]>({
    queryKey: ["tax-unpaid-invoices"],
    queryFn: () =>
      apiFetch<UnpaidInvoice[]>("/business/tax-payments/unpaid-invoices"),
  });

  const deleteMutation = useMutation<void, ApiError, string>({
    mutationFn: (id) =>
      apiFetch(`/business/tax-payments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["tax-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["tax-payments"] });
      void queryClient.invalidateQueries({
        queryKey: ["tax-unpaid-invoices"],
      });
    },
  });

  const filteredPayments = useMemo(() => {
    let rows = payments ?? [];
    if (paymentSearch.trim()) {
      const q = paymentSearch.toLowerCase();
      rows = rows.filter(
        (p) =>
          (p.payment_method ?? "").toLowerCase().includes(q) ||
          (p.payment_reference ?? "").toLowerCase().includes(q) ||
          (p.notes ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [payments, paymentSearch]);

  const filteredUnpaid = useMemo(() => {
    let rows = unpaid ?? [];
    if (unpaidSearch.trim()) {
      const q = unpaidSearch.toLowerCase();
      rows = rows.filter(
        (i) =>
          i.invoice_number.toLowerCase().includes(q) ||
          i.client_name.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [unpaid, unpaidSearch]);

  function handleDelete() {
    if (!selectedId) return;
    if (
      !window.confirm(
        "Delete this GST payment? Linked invoices will reappear in 'Invoices with Unpaid GST'.",
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
              <Link
                to="/payments"
                className="text-muted-foreground hover:text-foreground"
              >
                Payments
              </Link>
              <Link to="/taxes" className="font-medium">
                Taxes
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">GST Payments</h2>
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => navigate("/taxes/new")}
          >
            Record GST Payment
          </Button>
        </div>

        {/* KPI cards */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KPICard
            label="GST Unpaid"
            value={summary?.gst_unpaid ?? 0}
            color="text-red-600"
          />
          <KPICard
            label="Unpaid Income"
            value={summary?.unpaid_income ?? 0}
            color="text-foreground"
          />
          <KPICard
            label="Total GST Paid"
            value={summary?.total_gst_paid ?? 0}
            color="text-foreground"
          />
        </div>

        {/* Search for payments */}
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search GST payments…"
            value={paymentSearch}
            onChange={(e) => setPaymentSearch(e.target.value)}
            className="flex-1"
            aria-label="Search GST payments"
          />
          <Button
            variant="outline"
            onClick={() => setPaymentSearch("")}
            disabled={!paymentSearch}
          >
            Clear
          </Button>
        </div>

        {/* GST payments table */}
        <Card className="mb-6">
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
            {!isLoading && !isError && filteredPayments.length === 0 && (
              <p className="p-6 text-muted-foreground">No GST payments yet.</p>
            )}
            {filteredPayments.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Invoices
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Income
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        GST Amount
                      </th>
                      <th className="px-4 py-2 font-semibold">Method</th>
                      <th className="px-4 py-2 font-semibold">Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map((p) => {
                      const isSelected = p.id === selectedId;
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
                          onDoubleClick={() => navigate(`/taxes/${p.id}`)}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {formatDate(p.payment_date)}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {p.invoice_count}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {formatCAD(num(p.income))}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {formatCAD(num(p.amount))}
                          </td>
                          <td className="px-4 py-2">
                            {p.payment_method ?? "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {p.payment_reference ?? "—"}
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

        {/* Invoices with unpaid GST */}
        <h3 className="mb-3 text-lg font-semibold">Invoices with Unpaid GST</h3>
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search invoice # or client…"
            value={unpaidSearch}
            onChange={(e) => setUnpaidSearch(e.target.value)}
            className="flex-1"
            aria-label="Search unpaid invoices"
          />
          <Button
            variant="outline"
            onClick={() => setUnpaidSearch("")}
            disabled={!unpaidSearch}
          >
            Clear
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {filteredUnpaid.length === 0 ? (
              <p className="p-6 text-muted-foreground">
                No invoices currently have unpaid GST.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Invoice #</th>
                      <th className="px-4 py-2 font-semibold">Client</th>
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Total
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        GST Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUnpaid.map((inv) => (
                      <tr
                        key={inv.invoice_id}
                        className="border-b last:border-0 hover:bg-accent/40 cursor-pointer"
                        onClick={() => navigate(`/invoices/${inv.invoice_id}`)}
                      >
                        <td className="px-4 py-2 font-medium">
                          {inv.invoice_number}
                        </td>
                        <td className="px-4 py-2">{inv.client_name}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatDate(inv.issue_date)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {formatCAD(num(inv.total))}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold">
                          {formatCAD(num(inv.tax_amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer buttons */}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => selectedId && navigate(`/taxes/${selectedId}`)}
            disabled={!selectedId}
          >
            View Invoices
          </Button>
          <Button
            variant="outline"
            onClick={() => selectedId && navigate(`/taxes/${selectedId}`)}
            disabled={!selectedId}
          >
            Edit Payment
          </Button>
          <Button
            variant="outline"
            onClick={() => selectedId && navigate(`/taxes/${selectedId}/link`)}
            disabled={!selectedId}
          >
            Link Invoices
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!selectedId || deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete Payment"}
          </Button>
        </div>
      </main>
    </div>
  );
}

function KPICard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="rounded-md border bg-card px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>
        {formatCAD(num(value))}
      </p>
    </div>
  );
}
