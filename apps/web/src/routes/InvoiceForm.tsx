/**
 * InvoiceForm — shared create/edit form for invoices.
 *
 * Exported route components:
 *   NewInvoice  — POST /business/invoices/ on save.
 *   EditInvoice — GET /business/invoices/:id, then PUT /business/invoices/:id.
 *
 * Layout (matches Image #17/#18 in the brief):
 *   Invoice Details: Invoice # / Client / Issue Date / Due Date /
 *                    Payment Terms / Notes
 *   Line Items: editable table — Description, Qty, Unit Price, Taxable,
 *                Tax Rate %, Tax ($), Total ($)
 *               Buttons: Add Line / Remove Selected
 *   Totals: Subtotal / GST / Total
 *   Footer buttons: Cancel · Save (· Mark Sent · Download PDF on edit)
 *
 * Totals are computed in the client (pure helpers in lib/invoice.ts) for live
 * feedback; the server recomputes on save so the UI math is purely cosmetic.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch, apiFetchBlob, ApiError } from "@/lib/api";
import type {
  ClientRead,
  InvoiceLineItemInput,
  InvoiceWithLines,
  InvoiceRead,
} from "@/types/api";
import {
  formatCAD,
  invoiceTotals,
  lineTotals,
  num,
  toIsoDate,
} from "@/lib/invoice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/AppHeader";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

interface InvoiceFormState {
  invoice_number: string;
  client_id: string;
  issue_date: string;
  due_date: string;
  payment_terms: string;
  notes: string;
  line_items: InvoiceLineItemInput[];
}

function defaultState(today: Date): InvoiceFormState {
  return {
    invoice_number: "",
    client_id: "",
    issue_date: toIsoDate(today),
    due_date: toIsoDate(addDays(today, 30)),
    payment_terms: "Net 30",
    notes: "",
    line_items: [
      {
        line_order: 1,
        description: "Consulting Services",
        quantity: "0",
        unit_price: "0",
        is_taxable: true,
        tax_rate: "0.0500",
        tax_category: "GST",
      },
    ],
  };
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function fromInvoice(data: InvoiceWithLines): InvoiceFormState {
  return {
    invoice_number: data.invoice.invoice_number,
    client_id: data.invoice.client_id,
    issue_date: data.invoice.issue_date,
    due_date: data.invoice.due_date ?? "",
    payment_terms: data.invoice.payment_terms ?? "",
    notes: data.invoice.notes ?? "",
    line_items: data.line_items.map((ln) => ({
      line_order: ln.line_order,
      description: ln.description,
      quantity: String(ln.quantity ?? "0"),
      unit_price: String(ln.unit_price ?? "0"),
      is_taxable: ln.is_taxable,
      tax_rate: ln.tax_rate !== null ? String(ln.tax_rate) : null,
      tax_category: ln.tax_category,
    })),
  };
}

interface InnerProps {
  mode: "create" | "edit";
  invoiceId?: string;
  initialStatus?: string;
  initialState: InvoiceFormState;
}

function InvoiceFormInner({
  mode,
  invoiceId,
  initialStatus,
  initialState,
}: InnerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<InvoiceFormState>(initialState);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  // Refresh when edit data arrives.
  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  const { data: clients } = useQuery<ClientRead[]>({
    queryKey: ["clients", "active"],
    queryFn: () =>
      apiFetch<ClientRead[]>("/business/clients/?include_archived=true"),
    staleTime: 60_000,
  });

  const totals = useMemo(
    () => invoiceTotals(state.line_items),
    [state.line_items],
  );

  function updateLine(index: number, patch: Partial<InvoiceLineItemInput>) {
    setState((s) => ({
      ...s,
      line_items: s.line_items.map((ln, i) =>
        i === index ? { ...ln, ...patch } : ln,
      ),
    }));
  }

  function addLine() {
    setState((s) => ({
      ...s,
      line_items: [
        ...s.line_items,
        {
          line_order: s.line_items.length + 1,
          description: "Consulting Services",
          quantity: "0",
          unit_price: "0",
          is_taxable: true,
          tax_rate: "0.0500",
          tax_category: "GST",
        },
      ],
    }));
  }

  function removeSelected() {
    if (selectedRows.size === 0) return;
    setState((s) => ({
      ...s,
      line_items: s.line_items
        .filter((_, i) => !selectedRows.has(i))
        .map((ln, i) => ({ ...ln, line_order: i + 1 })),
    }));
    setSelectedRows(new Set());
  }

  function toggleRow(index: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const saveMutation = useMutation<InvoiceWithLines, ApiError, void>({
    mutationFn: async () => {
      const body = {
        invoice_number: state.invoice_number,
        client_id: state.client_id,
        issue_date: state.issue_date,
        due_date: state.due_date || null,
        status: mode === "create" ? "draft" : null,
        currency: "CAD",
        notes: state.notes || null,
        payment_terms: state.payment_terms || null,
        line_items: state.line_items,
      };
      if (mode === "create") {
        return apiFetch<InvoiceWithLines>("/business/invoices/", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } else {
        return apiFetch<InvoiceWithLines>(`/business/invoices/${invoiceId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      }
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({
        queryKey: ["invoice", saved.invoice.id],
      });
      navigate(`/invoices/${saved.invoice.id}`);
    },
  });

  const markSentMutation = useMutation<InvoiceRead, ApiError, void>({
    mutationFn: () =>
      apiFetch<InvoiceRead>(`/business/invoices/${invoiceId}/mark-sent`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      navigate("/invoices");
    },
  });

  async function downloadPdf() {
    if (!invoiceId) return;
    const blob = await apiFetchBlob(`/business/invoices/${invoiceId}/pdf`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.invoice_number || "invoice"}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  const heading =
    mode === "create"
      ? "New Invoice"
      : `Edit Invoice - ${state.invoice_number || ""}`;

  const canMarkSent =
    mode === "edit" && initialStatus !== "sent" && initialStatus !== "paid";

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-5xl px-4 py-6">
        <h2 className="mb-6 text-2xl font-bold">{heading}</h2>

        <form onSubmit={handleSubmit} className="space-y-6" noValidate>
          {/* Invoice Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Invoice Details</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="invoice_number">Invoice #*</Label>
                <Input
                  id="invoice_number"
                  required
                  value={state.invoice_number}
                  onChange={(e) =>
                    setState({ ...state, invoice_number: e.target.value })
                  }
                  placeholder="INV-2026-0001"
                />
              </div>
              <div>
                <Label htmlFor="client_id">Client*</Label>
                <select
                  id="client_id"
                  required
                  className={SELECT_CLASSES}
                  value={state.client_id}
                  onChange={(e) =>
                    setState({ ...state, client_id: e.target.value })
                  }
                >
                  <option value="">Select a client…</option>
                  {(clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="issue_date">Issue Date*</Label>
                <Input
                  id="issue_date"
                  type="date"
                  required
                  value={state.issue_date}
                  onChange={(e) =>
                    setState({ ...state, issue_date: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="due_date">Due Date*</Label>
                <Input
                  id="due_date"
                  type="date"
                  required
                  value={state.due_date}
                  onChange={(e) =>
                    setState({ ...state, due_date: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="payment_terms">Payment Terms</Label>
                <Input
                  id="payment_terms"
                  value={state.payment_terms}
                  onChange={(e) =>
                    setState({ ...state, payment_terms: e.target.value })
                  }
                  placeholder="Net 30"
                />
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <textarea
                  id="notes"
                  className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={state.notes}
                  onChange={(e) =>
                    setState({ ...state, notes: e.target.value })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Line Items */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Line Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="w-10 px-2 py-2"></th>
                      <th className="px-2 py-2 font-semibold">Description</th>
                      <th className="px-2 py-2 font-semibold">Qty</th>
                      <th className="px-2 py-2 font-semibold">Unit Price</th>
                      <th className="px-2 py-2 font-semibold">Taxable</th>
                      <th className="px-2 py-2 font-semibold">Tax Rate %</th>
                      <th className="px-2 py-2 text-right font-semibold">
                        Tax
                      </th>
                      <th className="px-2 py-2 text-right font-semibold">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.line_items.map((line, idx) => {
                      const lt = lineTotals(line);
                      return (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedRows.has(idx)}
                              onChange={() => toggleRow(idx)}
                              aria-label={`Select line ${idx + 1}`}
                              className="h-4 w-4"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <Input
                              value={line.description}
                              onChange={(e) =>
                                updateLine(idx, { description: e.target.value })
                              }
                            />
                          </td>
                          <td className="px-2 py-2 w-24">
                            <Input
                              type="number"
                              step="0.01"
                              value={String(line.quantity)}
                              onChange={(e) =>
                                updateLine(idx, { quantity: e.target.value })
                              }
                              className="text-right"
                            />
                          </td>
                          <td className="px-2 py-2 w-28">
                            <Input
                              type="number"
                              step="0.01"
                              value={String(line.unit_price)}
                              onChange={(e) =>
                                updateLine(idx, { unit_price: e.target.value })
                              }
                              className="text-right"
                            />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={line.is_taxable}
                              onChange={(e) =>
                                updateLine(idx, {
                                  is_taxable: e.target.checked,
                                  tax_category: e.target.checked ? "GST" : null,
                                })
                              }
                              aria-label={`Taxable line ${idx + 1}`}
                              className="h-4 w-4"
                            />
                          </td>
                          <td className="px-2 py-2 w-24">
                            <Input
                              type="number"
                              step="0.01"
                              value={
                                line.tax_rate !== null
                                  ? (num(line.tax_rate) * 100).toFixed(2)
                                  : ""
                              }
                              onChange={(e) => {
                                const pct = num(e.target.value);
                                updateLine(idx, {
                                  tax_rate: String(pct / 100),
                                });
                              }}
                              className="text-right"
                              disabled={!line.is_taxable}
                            />
                          </td>
                          <td className="px-2 py-2 text-right font-medium">
                            {formatCAD(lt.tax)}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold">
                            {formatCAD(lt.total)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex gap-2">
                <Button type="button" variant="outline" onClick={addLine}>
                  Add Line
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={removeSelected}
                  disabled={selectedRows.size === 0}
                >
                  Remove Selected
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Totals */}
          <div className="flex justify-end">
            <Card className="w-full max-w-xs">
              <CardContent className="space-y-1 pt-6 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal:</span>
                  <span className="font-medium">
                    {formatCAD(totals.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GST:</span>
                  <span className="font-medium">{formatCAD(totals.tax)}</span>
                </div>
                <div className="flex justify-between border-t pt-2">
                  <span className="font-semibold">Total:</span>
                  <span className="text-lg font-bold">
                    {formatCAD(totals.total)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          {saveMutation.isError && (
            <p className="text-sm text-destructive">
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

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {mode === "edit" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void downloadPdf();
                }}
              >
                Download PDF
              </Button>
            )}
            {canMarkSent && (
              <Button
                type="button"
                variant="outline"
                onClick={() => markSentMutation.mutate()}
                disabled={markSentMutation.isPending}
              >
                Mark Sent
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/invoices")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

export function NewInvoice() {
  const today = useMemo(() => new Date(), []);
  return (
    <InvoiceFormInner mode="create" initialState={defaultState(today)} />
  );
}

export function EditInvoice() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery<InvoiceWithLines>({
    queryKey: ["invoice", id],
    queryFn: () => apiFetch<InvoiceWithLines>(`/business/invoices/${id}`),
    enabled: !!id,
  });

  if (isLoading || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading invoice…
      </main>
    );
  }
  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center text-destructive">
        Failed to load invoice:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </main>
    );
  }
  return (
    <InvoiceFormInner
      mode="edit"
      invoiceId={data.invoice.id}
      initialStatus={data.invoice.status}
      initialState={fromInvoice(data)}
    />
  );
}
