/**
 * PaymentForm — shared create/edit form for payments.
 *
 * Exported route components:
 *   NewPayment  — POST /business/payments/.
 *   EditPayment — GET /business/payments/:id, then PUT /business/payments/:id.
 *
 * Layout (matches Image #22):
 *   Invoice*: <dropdown showing "INV-XXXX - Client ($balance_due)">
 *   Balance Due: $X.XX
 *   Payment Date*: <date>
 *   Gross Amount*: $...
 *   ┌ Deductions (optional) ──────────────────────────────────────┐
 *   │ Deduction Amount: $...                                       │
 *   │ Description:      <e.g., CTADMINFEE>                         │
 *   └──────────────────────────────────────────────────────────────┘
 *   Net Amount Received: $X.XX  (green — gross - deduction)
 *   Payment Method*: <select>
 *   Reference: ...
 *   Notes: ...
 *
 *   [Cancel] [Save]
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
  InvoiceOption,
  PaymentCreate,
  PaymentRead,
} from "@/types/api";
import { formatCAD, num, round2, toIsoDate } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignOutButton } from "@/components/SignOutButton";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const PAYMENT_METHODS = ["EFT", "Bank Transfer", "Cheque", "Cash", "Other"];

interface FormState {
  invoice_id: string;
  payment_date: string;
  amount: string;
  deduction_amount: string;
  deduction_description: string;
  payment_method: string;
  reference: string;
  notes: string;
}

function defaultState(today: Date): FormState {
  return {
    invoice_id: "",
    payment_date: toIsoDate(today),
    amount: "0",
    deduction_amount: "0",
    deduction_description: "",
    payment_method: "EFT",
    reference: "",
    notes: "",
  };
}

function fromPayment(p: PaymentRead): FormState {
  return {
    invoice_id: p.invoice_id,
    payment_date: p.payment_date,
    amount: String(p.amount ?? "0"),
    deduction_amount: String(p.deduction_amount ?? "0"),
    deduction_description: p.deduction_description ?? "",
    payment_method: p.payment_method ?? "EFT",
    reference: p.reference ?? "",
    notes: p.notes ?? "",
  };
}

interface InnerProps {
  mode: "create" | "edit";
  paymentId?: string;
  initialState: FormState;
  /** When editing, the amount of the payment before this edit — so we can
   * back it out of the invoice's existing-paid total to show the right
   * balance due. */
  existingPaymentAmount?: number;
}

function PaymentFormInner({
  mode,
  paymentId,
  initialState,
  existingPaymentAmount = 0,
}: InnerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<FormState>(initialState);

  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  const { data: invoices } = useQuery<InvoiceOption[]>({
    queryKey: ["invoice-options"],
    queryFn: () =>
      apiFetch<InvoiceOption[]>("/business/payments/invoice-options"),
    staleTime: 30_000,
  });

  const selectedInvoice = useMemo(
    () =>
      (invoices ?? []).find((opt) => opt.invoice_id === state.invoice_id) ??
      null,
    [invoices, state.invoice_id],
  );

  // Balance available to pay = invoice.balance_due + this payment's current
  // amount (since balance_due already subtracted it).
  const balanceDue = selectedInvoice
    ? round2(num(selectedInvoice.balance_due) + existingPaymentAmount)
    : 0;

  const grossNum = num(state.amount);
  const deductionNum = num(state.deduction_amount);
  const netNum = round2(grossNum - deductionNum);

  const saveMutation = useMutation<PaymentRead, ApiError, void>({
    mutationFn: async () => {
      const body: PaymentCreate = {
        invoice_id: state.invoice_id,
        payment_date: state.payment_date,
        amount: state.amount,
        deduction_amount: state.deduction_amount,
        deduction_description: state.deduction_description || null,
        payment_method: state.payment_method || null,
        reference: state.reference || null,
        notes: state.notes || null,
      };
      if (mode === "create") {
        return apiFetch<PaymentRead>("/business/payments/", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } else {
        return apiFetch<PaymentRead>(`/business/payments/${paymentId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void queryClient.invalidateQueries({ queryKey: ["invoice-options"] });
      navigate("/payments");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
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
              <Link to="/payments" className="font-medium">
                Payments
              </Link>
              <Link
                to="/taxes"
                className="text-muted-foreground hover:text-foreground"
              >
                Taxes
              </Link>
              <Link
                to="/transfers"
                className="text-muted-foreground hover:text-foreground"
              >
                Transfers
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        <h2 className="mb-6 text-2xl font-bold">
          {mode === "create" ? "Record Payment" : "Edit Payment"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Card>
            <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-center">
              <Label htmlFor="invoice_id">
                Invoice <span className="text-destructive">*</span>
              </Label>
              <select
                id="invoice_id"
                required
                className={SELECT_CLASSES}
                value={state.invoice_id}
                onChange={(e) =>
                  setState({ ...state, invoice_id: e.target.value })
                }
              >
                <option value="">Select an invoice…</option>
                {(invoices ?? []).map((opt) => (
                  <option key={opt.invoice_id} value={opt.invoice_id}>
                    {opt.invoice_number} - {opt.client_name} (
                    {formatCAD(num(opt.balance_due))})
                  </option>
                ))}
              </select>

              <Label>Balance Due</Label>
              <div className="text-base">
                {selectedInvoice ? formatCAD(balanceDue) : "—"}
              </div>

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
                Gross Amount <span className="text-destructive">*</span>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deductions (optional)</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
              <Label htmlFor="deduction_amount">Deduction Amount</Label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="deduction_amount"
                  type="number"
                  step="0.01"
                  className="pl-6"
                  value={state.deduction_amount}
                  onChange={(e) =>
                    setState({ ...state, deduction_amount: e.target.value })
                  }
                />
              </div>

              <Label htmlFor="deduction_description">Description</Label>
              <Input
                id="deduction_description"
                placeholder="e.g., CTADMINFEE, Processing Fee"
                value={state.deduction_description}
                onChange={(e) =>
                  setState({
                    ...state,
                    deduction_description: e.target.value,
                  })
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-center">
              <Label>Net Amount Received</Label>
              <div className="text-base font-semibold text-emerald-700">
                {formatCAD(netNum)}
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

              <Label htmlFor="reference">Reference</Label>
              <Input
                id="reference"
                placeholder="e.g., EFT000000271809"
                value={state.reference}
                onChange={(e) =>
                  setState({ ...state, reference: e.target.value })
                }
              />

              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={state.notes}
                onChange={(e) =>
                  setState({ ...state, notes: e.target.value })
                }
              />
            </CardContent>
          </Card>

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

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate("/payments")}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              disabled={saveMutation.isPending || !state.invoice_id}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

export function NewPayment() {
  const today = useMemo(() => new Date(), []);
  return (
    <PaymentFormInner mode="create" initialState={defaultState(today)} />
  );
}

export function EditPayment() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery<PaymentRead>({
    queryKey: ["payment", id],
    queryFn: () => apiFetch<PaymentRead>(`/business/payments/${id}`),
    enabled: !!id,
  });

  if (isLoading || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading payment…
      </main>
    );
  }
  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center text-destructive">
        Failed to load payment:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </main>
    );
  }
  return (
    <PaymentFormInner
      mode="edit"
      paymentId={data.id}
      initialState={fromPayment(data)}
      existingPaymentAmount={num(data.amount)}
    />
  );
}
