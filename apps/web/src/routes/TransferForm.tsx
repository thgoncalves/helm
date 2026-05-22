/**
 * TransferForm — new/edit a Company → Personal transfer.
 *
 * Matches Image #29:
 *   Date* · Amount* · Category* · Method* · Purpose · [✓] Auto-estimate taxes
 *   Tax Estimates card:
 *     Company Tax  ($) — disabled when auto-estimate is on
 *     Personal Tax ($) — disabled when auto-estimate is on
 *     Total Estimated Tax (sum, read-only)
 *   Notes
 *   Cancel · Save
 *
 * Auto-estimate uses GET /business/transfers/tax-rates (which reads
 * transfer_tax_rate_company / transfer_tax_rate_personal from settings).
 * Unchecking the box leaves the user's typed values intact and lets them
 * override per-row (e.g. for a transfer with a one-off tax treatment).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  TransferCreate,
  TransferRead,
  TransferTaxRates,
} from "@/types/api";
import { formatCAD, num, round2, toIsoDate } from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingScreen } from "@/components/LoadingScreen";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const CATEGORIES = ["Salary", "Dividend", "Bonus", "Loan Repayment", "Other"];
const METHODS = ["EFT", "Bank Transfer", "Cheque", "Cash", "Other"];

interface FormState {
  transfer_date: string;
  amount: string;
  category: string;
  method: string;
  purpose: string;
  notes: string;
  auto_estimate: boolean;
  est_company: string;
  est_personal: string;
}

function defaultState(today: Date): FormState {
  return {
    transfer_date: toIsoDate(today),
    amount: "0",
    category: "Salary",
    method: "EFT",
    purpose: "",
    notes: "",
    auto_estimate: true,
    est_company: "0",
    est_personal: "0",
  };
}

function fromTransfer(t: TransferRead): FormState {
  return {
    transfer_date: t.transfer_date,
    amount: String(t.amount ?? "0"),
    category: t.category ?? "Salary",
    method: t.method ?? "EFT",
    purpose: t.purpose ?? "",
    notes: t.notes ?? "",
    // If the persisted values were saved we treat them as the user's
    // "manual override" baseline — but we still leave auto on by default
    // so toggling instantly recomputes. The user can untick to keep
    // these exact values.
    auto_estimate: true,
    est_company: String(t.estimated_tax_company ?? "0"),
    est_personal: String(t.estimated_tax_personal ?? "0"),
  };
}

interface InnerProps {
  mode: "create" | "edit";
  transferId?: string;
  initialState: FormState;
}

function TransferFormInner({ mode, transferId, initialState }: InnerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<FormState>(initialState);

  useEffect(() => {
    setState(initialState);
  }, [initialState]);

  const { data: rates } = useQuery<TransferTaxRates>({
    queryKey: ["transfer-tax-rates"],
    queryFn: () =>
      apiFetch<TransferTaxRates>("/business/transfers/tax-rates"),
    staleTime: 60_000,
  });

  // When auto-estimate is on, recompute the two tax fields whenever amount
  // or rates change.
  useEffect(() => {
    if (!state.auto_estimate || !rates) return;
    const amount = num(state.amount);
    const company = round2(amount * num(rates.company_rate));
    const personal = round2(amount * num(rates.personal_rate));
    // Only patch if the strings would actually change, to avoid render loops.
    setState((s) =>
      s.auto_estimate &&
      (s.est_company !== company.toFixed(2) ||
        s.est_personal !== personal.toFixed(2))
        ? {
            ...s,
            est_company: company.toFixed(2),
            est_personal: personal.toFixed(2),
          }
        : s,
    );
  }, [state.amount, state.auto_estimate, rates]);

  const totalEstimated = useMemo(
    () => round2(num(state.est_company) + num(state.est_personal)),
    [state.est_company, state.est_personal],
  );

  const saveMutation = useMutation<TransferRead, ApiError, void>({
    mutationFn: async () => {
      const body: TransferCreate = {
        transfer_date: state.transfer_date,
        amount: state.amount,
        method: state.method || null,
        purpose: state.purpose || null,
        category: state.category || null,
        estimated_tax_company: state.est_company || null,
        estimated_tax_personal: state.est_personal || null,
        actual_tax_paid_company: null,
        actual_tax_paid_personal: null,
        tax_ledger_link_company: null,
        tax_ledger_link_personal: null,
        notes: state.notes || null,
      };
      if (mode === "create") {
        return apiFetch<TransferRead>("/business/transfers/", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } else {
        return apiFetch<TransferRead>(
          `/business/transfers/${transferId}`,
          { method: "PUT", body: JSON.stringify(body) },
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["transfers"] });
      void queryClient.invalidateQueries({
        queryKey: ["transfers-summary"],
      });
      if (transferId) {
        void queryClient.invalidateQueries({
          queryKey: ["transfer", transferId],
        });
      }
      navigate("/transfers");
    },
  });

  const deleteMutation = useMutation<void, ApiError, void>({
    mutationFn: () =>
      apiFetch(`/business/transfers/${transferId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["transfers"] });
      void queryClient.invalidateQueries({
        queryKey: ["transfers-summary"],
      });
      navigate("/transfers");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  function handleDelete() {
    if (!window.confirm("Delete this transfer?")) return;
    deleteMutation.mutate();
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <h2 className="mb-6 text-2xl font-bold">
        {mode === "create" ? "New Transfer" : "Edit Transfer"}
      </h2>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-center">
            <Label htmlFor="transfer_date">
              Date <span className="text-destructive">*</span>
            </Label>
            <Input
              id="transfer_date"
              type="date"
              required
              value={state.transfer_date}
              onChange={(e) =>
                setState({ ...state, transfer_date: e.target.value })
              }
            />

            <Label htmlFor="amount">
              Amount <span className="text-destructive">*</span>
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

            <Label htmlFor="category">
              Category <span className="text-destructive">*</span>
            </Label>
            <select
              id="category"
              required
              className={SELECT_CLASSES}
              value={state.category}
              onChange={(e) =>
                setState({ ...state, category: e.target.value })
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <Label htmlFor="method">
              Method <span className="text-destructive">*</span>
            </Label>
            <select
              id="method"
              required
              className={SELECT_CLASSES}
              value={state.method}
              onChange={(e) =>
                setState({ ...state, method: e.target.value })
              }
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            <Label htmlFor="purpose">Purpose</Label>
            <Input
              id="purpose"
              value={state.purpose}
              onChange={(e) =>
                setState({ ...state, purpose: e.target.value })
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <input
                id="auto_estimate"
                type="checkbox"
                className="h-4 w-4 cursor-pointer rounded border-input"
                checked={state.auto_estimate}
                onChange={(e) =>
                  setState({
                    ...state,
                    auto_estimate: e.target.checked,
                  })
                }
              />
              <Label
                htmlFor="auto_estimate"
                className="cursor-pointer text-sm font-medium"
              >
                Auto-estimate taxes
              </Label>
            </div>
            <CardTitle className="text-base">Tax Estimates</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
            <Label htmlFor="est_company">Company Tax</Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="est_company"
                type="number"
                step="0.01"
                className="pl-6"
                disabled={state.auto_estimate}
                value={state.est_company}
                onChange={(e) =>
                  setState({ ...state, est_company: e.target.value })
                }
              />
            </div>

            <Label htmlFor="est_personal">Personal Tax</Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                $
              </span>
              <Input
                id="est_personal"
                type="number"
                step="0.01"
                className="pl-6"
                disabled={state.auto_estimate}
                value={state.est_personal}
                onChange={(e) =>
                  setState({ ...state, est_personal: e.target.value })
                }
              />
            </div>

            <Label>Total Estimated Tax</Label>
            <p className="font-semibold">{formatCAD(totalEstimated)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-start">
            <Label htmlFor="notes" className="pt-2">
              Notes
            </Label>
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
              onClick={() => navigate("/transfers")}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </main>

  );
}

export function NewTransfer() {
  const today = useMemo(() => new Date(), []);
  return (
    <TransferFormInner mode="create" initialState={defaultState(today)} />
  );
}

export function EditTransfer() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error } = useQuery<TransferRead>({
    queryKey: ["transfer", id],
    queryFn: () => apiFetch<TransferRead>(`/business/transfers/${id}`),
    enabled: !!id,
  });

  if (isLoading || !data) {
    return <LoadingScreen />;
  }
  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center text-destructive">
        Failed to load transfer:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </main>
    );
  }
  return (
    <TransferFormInner
      mode="edit"
      transferId={data.id}
      initialState={fromTransfer(data)}
    />
  );
}
