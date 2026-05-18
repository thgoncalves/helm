/**
 * AccountContributions — per-account log of deposits and withdrawals.
 *
 * Each row records:
 *  - the date of the contribution
 *  - the amount and currency (in the account's native currency)
 *  - the BoC FX rate snapshot to CAD on that date (1.0 for CAD accounts)
 *  - the CAD-equivalent value (signed by kind), used to roll up
 *    "how much CAD have I put into this account"
 *
 * The FX snapshot is captured server-side on POST/PATCH — the client
 * never sends a rate. That keeps cost basis history honest even if
 * BoC's published rates shift after the fact.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  ContributionKind,
  InvestmentAccountRead,
  InvestmentContributionCreate,
  InvestmentContributionRead,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { labelForAccountKind } from "@/lib/accountKind";
import { cn } from "@/lib/utils";

interface FormState {
  contributed_on: string;
  kind: ContributionKind;
  amount: string;
  currency: string;
  notes: string;
}

function emptyForm(currency: string): FormState {
  return {
    contributed_on: new Date().toISOString().slice(0, 10),
    kind: "deposit",
    amount: "",
    currency,
    notes: "",
  };
}

function fmt(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

function fmtCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function AccountContributions() {
  const { id: accountId } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const accountQ = useQuery<InvestmentAccountRead[]>({
    queryKey: ["investment-accounts"],
    queryFn: () =>
      apiFetch<InvestmentAccountRead[]>("/investments/accounts/"),
  });
  const account = accountQ.data?.find((a) => a.id === accountId);

  const contributionsQ = useQuery<InvestmentContributionRead[]>({
    queryKey: ["investment-contributions", accountId],
    queryFn: () =>
      apiFetch<InvestmentContributionRead[]>(
        `/investments/accounts/${accountId}/contributions`,
      ),
    enabled: !!accountId,
  });

  const [form, setForm] = useState<FormState>(() => emptyForm("CAD"));
  const [serverError, setServerError] = useState<string | null>(null);

  // Pre-fill currency from the account once it loads.
  useMemo(() => {
    if (account && !form.amount && form.currency === "CAD") {
      setForm((s) => ({ ...s, currency: account.currency }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const createMutation = useMutation<
    InvestmentContributionRead,
    ApiError,
    InvestmentContributionCreate
  >({
    mutationFn: (body) =>
      apiFetch<InvestmentContributionRead>(
        `/investments/accounts/${accountId}/contributions`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      setServerError(null);
      setForm((s) => emptyForm(s.currency));
      void queryClient.invalidateQueries({
        queryKey: ["investment-contributions", accountId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["contribution-room"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["investments-portfolio"],
      });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  const deleteMutation = useMutation<void, ApiError, string>({
    mutationFn: (id) =>
      apiFetch<void>(
        `/investments/accounts/${accountId}/contributions/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["investment-contributions", accountId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["contribution-room"],
      });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !form.amount.trim()) return;
    createMutation.mutate({
      contributed_on: form.contributed_on,
      kind: form.kind,
      amount: form.amount,
      currency: form.currency.toUpperCase(),
      notes: form.notes.trim() || null,
    });
  }

  const contributions = contributionsQ.data ?? [];
  const totals = useMemo(() => {
    let deposits = 0;
    let withdrawals = 0;
    let cadNet = 0;
    for (const c of contributions) {
      const amt = fmt(c.amount);
      const cad = fmt(c.amount_cad);
      if (c.kind === "deposit") deposits += amt;
      else withdrawals += amt;
      cadNet += cad;
    }
    return { deposits, withdrawals, cadNet };
  }, [contributions]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Contributions</h2>
            {account ? (
              <p className="text-sm text-muted-foreground">
                {account.name} · {labelForAccountKind(account.kind)} ·{" "}
                {account.currency}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </div>
          <Link
            to="/investments/accounts"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            ← All accounts
          </Link>
        </div>

        {account && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <h3 className="mb-3 text-sm font-semibold">
                Record a deposit or withdrawal
              </h3>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1">
                    <Label htmlFor="c-date">Date</Label>
                    <Input
                      id="c-date"
                      type="date"
                      value={form.contributed_on}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          contributed_on: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="c-kind">Kind</Label>
                    <select
                      id="c-kind"
                      value={form.kind}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          kind: e.target.value as ContributionKind,
                        }))
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="deposit">Deposit (money in)</option>
                      <option value="withdrawal">
                        Withdrawal (money out)
                      </option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="c-amount">Amount</Label>
                    <Input
                      id="c-amount"
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.amount}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, amount: e.target.value }))
                      }
                      placeholder="1000.00"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="c-currency">Currency</Label>
                    <Input
                      id="c-currency"
                      value={form.currency}
                      maxLength={3}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          currency: e.target.value.toUpperCase(),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-4">
                    <Label htmlFor="c-notes">Notes</Label>
                    <Input
                      id="c-notes"
                      value={form.notes}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, notes: e.target.value }))
                      }
                      placeholder="Quarterly DCA, employer match, etc."
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    disabled={!form.amount.trim() || createMutation.isPending}
                  >
                    {createMutation.isPending
                      ? "Saving…"
                      : `Record ${form.kind}`}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {form.currency === "CAD"
                      ? "No FX conversion needed."
                      : `FX rate to CAD will be auto-pulled from Bank of Canada for ${form.contributed_on}.`}
                  </p>
                  {serverError && (
                    <span className="text-sm text-destructive" role="alert">
                      {serverError}
                    </span>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {contributionsQ.isLoading && (
          <p className="text-muted-foreground">Loading contributions…</p>
        )}
        {contributions.length === 0 && contributionsQ.isSuccess && (
          <p className="text-sm text-muted-foreground">
            No contributions recorded yet.
          </p>
        )}

        {contributions.length > 0 && account && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">History</h3>
                <div className="text-xs text-muted-foreground">
                  Deposits:{" "}
                  <span className="font-medium text-foreground">
                    {fmtCurrency(totals.deposits, account.currency)}
                  </span>
                  {" · "}
                  Withdrawals:{" "}
                  <span className="font-medium text-foreground">
                    {fmtCurrency(totals.withdrawals, account.currency)}
                  </span>
                  {" · "}
                  Net (CAD):{" "}
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      totals.cadNet < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-foreground",
                    )}
                  >
                    {fmtCurrency(totals.cadNet, "CAD")}
                  </span>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium">Date</th>
                    <th className="py-2 text-left font-medium">Kind</th>
                    <th className="py-2 text-right font-medium">Amount</th>
                    <th className="py-2 text-right font-medium">FX → CAD</th>
                    <th className="py-2 text-right font-medium">CAD</th>
                    <th className="py-2 text-left font-medium">Notes</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {contributions.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="py-2 tabular-nums">{c.contributed_on}</td>
                      <td className="py-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs font-medium",
                            c.kind === "deposit"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
                          )}
                        >
                          {c.kind}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {fmtCurrency(fmt(c.amount), c.currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {c.currency === "CAD"
                          ? "—"
                          : fmt(c.fx_rate_cad).toFixed(4)}
                      </td>
                      <td
                        className={cn(
                          "py-2 text-right tabular-nums",
                          fmt(c.amount_cad) < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-foreground",
                        )}
                      >
                        {fmtCurrency(fmt(c.amount_cad), "CAD")}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {c.notes ?? ""}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm("Delete this contribution?")) {
                              deleteMutation.mutate(c.id);
                            }
                          }}
                          className="text-xs text-destructive underline-offset-2 hover:underline"
                        >
                          delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object" && "message" in detail) {
        return String((detail as { message: unknown }).message);
      }
    }
    return `Server error ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}
