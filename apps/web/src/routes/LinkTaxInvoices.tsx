/**
 * LinkTaxInvoices — Link/Unlink Invoices dialog (Image #26).
 *
 * URL: /taxes/:id/link
 *
 * Lists every "linkable" invoice (currently linked to this payment OR not
 * linked to any payment). Checkboxes drive the selection; Save persists
 * the bulk replacement via PUT /business/tax-payments/:id/links.
 *
 * Summary footer mirrors the mock:
 *   "Selected: N invoices | Income: $X | GST: $Y".
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import type { LinkableInvoice, TaxPaymentRead } from "@/types/api";
import { formatCAD, num } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AppHeader } from "@/components/AppHeader";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function LinkTaxInvoices() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);

  const paymentQuery = useQuery<{
    payment: TaxPaymentRead;
    linked_invoices: LinkableInvoice[];
  }>({
    queryKey: ["tax-payment", id],
    queryFn: () => apiFetch(`/business/tax-payments/${id}`),
    enabled: !!id,
  });

  const linkableQuery = useQuery<LinkableInvoice[]>({
    queryKey: ["tax-linkable", id],
    queryFn: () =>
      apiFetch<LinkableInvoice[]>(
        `/business/tax-payments/${id}/linkable-invoices`,
      ),
    enabled: !!id,
  });

  // Seed selection from the server's currently-linked set on first load.
  useEffect(() => {
    if (!seeded && linkableQuery.data) {
      setSelected(
        new Set(
          linkableQuery.data
            .filter((i) => i.is_linked)
            .map((i) => i.invoice_id),
        ),
      );
      setSeeded(true);
    }
  }, [linkableQuery.data, seeded]);

  const saveMutation = useMutation<LinkableInvoice[], ApiError, void>({
    mutationFn: async () => {
      return apiFetch<LinkableInvoice[]>(
        `/business/tax-payments/${id}/links`,
        {
          method: "PUT",
          body: JSON.stringify({ invoice_ids: Array.from(selected) }),
        },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tax-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["tax-payments"] });
      void queryClient.invalidateQueries({
        queryKey: ["tax-unpaid-invoices"],
      });
      void queryClient.invalidateQueries({ queryKey: ["tax-payment", id] });
      void queryClient.invalidateQueries({ queryKey: ["tax-linkable", id] });
      navigate(`/taxes/${id}`);
    },
  });

  const rows = linkableQuery.data ?? [];

  const summary = useMemo(() => {
    let income = 0;
    let gst = 0;
    for (const row of rows) {
      if (selected.has(row.invoice_id)) {
        income += num(row.total);
        gst += num(row.tax_amount);
      }
    }
    return { count: selected.size, income, gst };
  }, [rows, selected]);

  function toggle(invoiceId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(rows.map((r) => r.invoice_id)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  const paymentDate = paymentQuery.data
    ? formatDate(paymentQuery.data.payment.payment_date)
    : "";
  const amount = paymentQuery.data
    ? formatCAD(num(paymentQuery.data.payment.amount))
    : "";

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-4xl px-4 py-6">
        <h2 className="mb-2 text-2xl font-bold">
          Link Invoices to Payment
          {paymentDate ? ` – ${paymentDate}` : ""}
        </h2>
        {paymentQuery.data && (
          <p className="mb-4 text-sm">
            Payment: <span className="font-semibold">{amount}</span> on{" "}
            <span className="font-semibold">{paymentDate}</span>
          </p>
        )}

        <div className="mb-3 flex gap-2">
          <Button variant="outline" onClick={selectAll}>
            Select All
          </Button>
          <Button variant="outline" onClick={deselectAll}>
            Deselect All
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {linkableQuery.isLoading && (
              <p className="p-6 text-muted-foreground">Loading invoices…</p>
            )}
            {linkableQuery.isError && (
              <p className="p-6 text-destructive">
                Failed to load invoices.
              </p>
            )}
            {!linkableQuery.isLoading && rows.length === 0 && (
              <p className="p-6 text-muted-foreground">
                No linkable invoices. Every GST-bearing invoice is already
                tied to a different payment.
              </p>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="w-10 px-2 py-2"></th>
                      <th className="w-10 px-2 py-2"></th>
                      <th className="px-2 py-2 font-semibold">Invoice #</th>
                      <th className="px-2 py-2 font-semibold">Client</th>
                      <th className="px-2 py-2 font-semibold">Date</th>
                      <th className="px-2 py-2 text-right font-semibold">
                        Total
                      </th>
                      <th className="px-2 py-2 text-right font-semibold">
                        GST
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => (
                      <tr
                        key={row.invoice_id}
                        className="border-b last:border-0 hover:bg-accent/40"
                      >
                        <td className="px-2 py-2 text-center text-muted-foreground">
                          {idx + 1}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Toggle ${row.invoice_number}`}
                            checked={selected.has(row.invoice_id)}
                            onChange={() => toggle(row.invoice_id)}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="px-2 py-2 font-medium">
                          {row.invoice_number}
                        </td>
                        <td className="px-2 py-2">{row.client_name}</td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {formatDate(row.issue_date)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {formatCAD(num(row.total))}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold">
                          {formatCAD(num(row.tax_amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-3 text-sm font-medium">
          Selected: {summary.count} invoice
          {summary.count === 1 ? "" : "s"} | Income:{" "}
          {formatCAD(summary.income)} | GST: {formatCAD(summary.gst)}
        </p>

        {saveMutation.isError && (
          <p className="mt-3 text-sm text-destructive">
            Save failed:{" "}
            {saveMutation.error instanceof ApiError
              ? typeof saveMutation.error.body === "object" &&
                saveMutation.error.body &&
                "detail" in saveMutation.error.body
                ? String(
                    (saveMutation.error.body as { detail: unknown }).detail,
                  )
                : `Server error ${saveMutation.error.status}`
              : String(saveMutation.error)}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(`/taxes/${id}`)}
          >
            Cancel
          </Button>
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </main>
    </div>
  );
}
