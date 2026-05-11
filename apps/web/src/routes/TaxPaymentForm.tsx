/**
 * TaxPaymentForm — new/edit a GST payment.
 *
 * Matches Image #25:
 *   Payment Date*, GST Amount*, Payment Method* (default ATO), Reference,
 *   Notes — then the read-only Linked Invoices table at the bottom (each
 *   row = an invoice currently linked to this payment). The summary line
 *   shows "N invoices | Income: $X | GST: $Y".
 *
 *   "Link / Unlink Invoices" navigates to /taxes/:id/link (a separate
 *   modal/page) — only available in edit mode (you need an id first).
 *
 *   Save persists header fields. Link replacement happens in the dialog.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  TaxPaymentRead,
  TaxPaymentWithLinks,
} from "@/types/api";
import { formatCAD, num, toIsoDate } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignOutButton } from "@/components/SignOutButton";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const PAYMENT_METHODS = ["ATO", "EFT", "Bank Transfer", "Cheque", "Other"];

interface FormState {
  payment_date: string;
  amount: string;
  payment_method: string;
  payment_reference: string;
  notes: string;
}

function defaultState(today: Date): FormState {
  return {
    payment_date: toIsoDate(today),
    amount: "0",
    payment_method: "ATO",
    payment_reference: "",
    notes: "",
  };
}

function fromPayment(p: TaxPaymentRead): FormState {
  return {
    payment_date: p.payment_date,
    amount: String(p.amount ?? "0"),
    payment_method: p.payment_method ?? "ATO",
    payment_reference: p.payment_reference ?? "",
    notes: p.notes ?? "",
  };
}

interface InnerProps {
  mode: "create" | "edit";
  paymentId?: string;
  initialState: FormState;
  initialLinks?: TaxPaymentWithLinks["linked_invoices"];
}

function TaxPaymentFormInner({
  mode,
  paymentId,
  initialState,
  initialLinks = [],
}: InnerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<FormState>(initialState);

  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  const linkedSummary = useMemo(() => {
    const count = initialLinks.length;
    let income = 0;
    let gst = 0;
    for (const l of initialLinks) {
      income += num(l.total);
      gst += num(l.tax_amount);
    }
    return { count, income, gst };
  }, [initialLinks]);

  const saveMutation = useMutation<TaxPaymentRead, ApiError, void>({
    mutationFn: async () => {
      const body = {
        payment_date: state.payment_date,
        amount: state.amount,
        payment_method: state.payment_method || null,
        payment_reference: state.payment_reference || null,
        notes: state.notes || null,
      };
      if (mode === "create") {
        const res = await apiFetch<TaxPaymentWithLinks>(
          "/business/tax-payments/",
          {
            method: "POST",
            body: JSON.stringify({ ...body, invoice_ids: [] }),
          },
        );
        return res.payment;
      } else {
        return apiFetch<TaxPaymentRead>(
          `/business/tax-payments/${paymentId}`,
          {
            method: "PUT",
            body: JSON.stringify(body),
          },
        );
      }
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["tax-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["tax-payments"] });
      void queryClient.invalidateQueries({
        queryKey: ["tax-payment", saved.id],
      });
      if (mode === "create") {
        // Hop to edit so the user can link invoices.
        navigate(`/taxes/${saved.id}`);
      } else {
        navigate("/taxes");
      }
    },
  });

  const deleteMutation = useMutation<void, ApiError, void>({
    mutationFn: () =>
      apiFetch(`/business/tax-payments/${paymentId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tax-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["tax-payments"] });
      void queryClient.invalidateQueries({
        queryKey: ["tax-unpaid-invoices"],
      });
      navigate("/taxes");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  function handleDelete() {
    if (
      !window.confirm(
        "Delete this GST payment? Linked invoices will reappear in 'Invoices with Unpaid GST'.",
      )
    ) {
      return;
    }
    deleteMutation.mutate();
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
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
              <Link
                to="/transfers"
                className="text-muted-foreground hover:text-foreground"
              >
                Transfers
              </Link>
              <Link
                to="/settings"
                className="text-muted-foreground hover:text-foreground"
              >
                Settings
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        <h2 className="mb-6 text-2xl font-bold">
          {mode === "create" ? "Record GST Payment" : "Edit GST Payment"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Card>
            <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-center">
              <Label htmlFor="payment_date">
                Payment Date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="payment_date"
                type="date"
                required
                value={state.payment_date}
                onChange={(e) =>
                  setState({ ...state, payment_date: e.target.value })
                }
              />

              <Label htmlFor="amount">
                GST Amount <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  required
                  className="pl-6"
                  value={state.amount}
                  onChange={(e) =>
                    setState({ ...state, amount: e.target.value })
                  }
                />
              </div>

              <Label htmlFor="payment_method">
                Payment Method <span className="text-destructive">*</span>
              </Label>
              <select
                id="payment_method"
                required
                className={SELECT_CLASSES}
                value={state.payment_method}
                onChange={(e) =>
                  setState({ ...state, payment_method: e.target.value })
                }
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <Label htmlFor="payment_reference">Reference</Label>
              <Input
                id="payment_reference"
                placeholder="e.g., 95F20-8364485"
                value={state.payment_reference}
                onChange={(e) =>
                  setState({ ...state, payment_reference: e.target.value })
                }
              />

              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="Optional notes"
                value={state.notes}
                onChange={(e) =>
                  setState({ ...state, notes: e.target.value })
                }
              />
            </CardContent>
          </Card>

          {/* Linked Invoices (edit mode only) */}
          {mode === "edit" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Linked Invoices</CardTitle>
              </CardHeader>
              <CardContent>
                {initialLinks.length === 0 ? (
                  <p className="text-muted-foreground">
                    No invoices linked yet. Use "Link / Unlink Invoices" to
                    attach some.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left">
                          <th className="px-2 py-2 w-10 font-semibold">#</th>
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
                        {initialLinks.map((l, idx) => (
                          <tr
                            key={l.invoice_id}
                            className="border-b last:border-0 hover:bg-accent/40 cursor-pointer"
                            onClick={() =>
                              navigate(`/invoices/${l.invoice_id}`)
                            }
                          >
                            <td className="px-2 py-2 text-muted-foreground">
                              {idx + 1}
                            </td>
                            <td className="px-2 py-2 font-medium">
                              {l.invoice_number}
                            </td>
                            <td className="px-2 py-2">{l.client_name}</td>
                            <td className="px-2 py-2 text-muted-foreground">
                              {l.issue_date}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {formatCAD(num(l.total))}
                            </td>
                            <td className="px-2 py-2 text-right font-semibold">
                              {formatCAD(num(l.tax_amount))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium">
                    {linkedSummary.count} invoice
                    {linkedSummary.count === 1 ? "" : "s"} | Income:{" "}
                    {formatCAD(linkedSummary.income)} | GST:{" "}
                    {formatCAD(linkedSummary.gst)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate(`/taxes/${paymentId}/link`)}
                  >
                    Link / Unlink Invoices
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

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

          <div className="flex items-center justify-between gap-2">
            <div>
              {mode === "edit" && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate("/taxes")}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-blue-600 hover:bg-blue-700 text-white"
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}

export function NewTaxPayment() {
  const today = useMemo(() => new Date(), []);
  return (
    <TaxPaymentFormInner mode="create" initialState={defaultState(today)} />
  );
}

export function EditTaxPayment() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery<TaxPaymentWithLinks>({
    queryKey: ["tax-payment", id],
    queryFn: () =>
      apiFetch<TaxPaymentWithLinks>(`/business/tax-payments/${id}`),
    enabled: !!id,
  });

  if (isLoading || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading GST payment…
      </main>
    );
  }
  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center text-destructive">
        Failed to load GST payment:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </main>
    );
  }
  return (
    <TaxPaymentFormInner
      mode="edit"
      paymentId={data.payment.id}
      initialState={fromPayment(data.payment)}
      initialLinks={data.linked_invoices}
    />
  );
}
