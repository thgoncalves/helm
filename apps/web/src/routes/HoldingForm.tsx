/**
 * HoldingForm — add a new holding or update an existing one.
 *
 * Both `/investments/holdings/new` and `/investments/holdings/:id` route
 * here. New-mode lets the user pick an account; edit-mode locks the
 * account (you can't "move" a holding between accounts — delete + recreate).
 */
import { useEffect, useState } from "react";
import { LoadingBox } from "@/components/LoadingScreen";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  AssetClass,
  InvestmentAccountRead,
  InvestmentHoldingCreate,
  InvestmentHoldingRead,
  InvestmentHoldingUpdate,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ASSET_CLASSES,
  labelForAssetClass,
} from "@/lib/assetClass";

interface FormState {
  account_id: string;
  ticker: string;
  asset_class: AssetClass;
  shares: string;
  avg_cost: string;
  current_price: string;
  currency: string;
  as_of: string;
  notes: string;
}

function emptyForm(): FormState {
  return {
    account_id: "",
    ticker: "",
    asset_class: "equity_international",
    shares: "",
    avg_cost: "",
    current_price: "",
    currency: "CAD",
    as_of: new Date().toISOString().slice(0, 10),
    notes: "",
  };
}

export function NewHolding() {
  return <HoldingForm mode="create" />;
}

export function EditHolding() {
  return <HoldingForm mode="edit" />;
}

function HoldingForm({ mode }: { mode: "create" | "edit" }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const accountsQ = useQuery<InvestmentAccountRead[]>({
    queryKey: ["investment-accounts"],
    queryFn: () =>
      apiFetch<InvestmentAccountRead[]>(
        "/investments/accounts/?active=true",
      ),
  });

  const holdingQ = useQuery<InvestmentHoldingRead>({
    queryKey: ["investment-holding", id],
    queryFn: () =>
      apiFetch<InvestmentHoldingRead>(`/investments/holdings/${id}`),
    enabled: mode === "edit" && !!id,
  });

  const [form, setForm] = useState<FormState>(emptyForm);
  const [serverError, setServerError] = useState<string | null>(null);

  // Seed form when editing.
  useEffect(() => {
    if (mode === "edit" && holdingQ.data) {
      setForm({
        account_id: holdingQ.data.account_id,
        ticker: holdingQ.data.ticker,
        asset_class: holdingQ.data.asset_class,
        shares: String(holdingQ.data.shares),
        avg_cost: String(holdingQ.data.avg_cost),
        current_price: String(holdingQ.data.current_price),
        currency: holdingQ.data.currency,
        as_of: holdingQ.data.as_of,
        notes: holdingQ.data.notes ?? "",
      });
    }
  }, [mode, holdingQ.data]);

  // On account pick (create mode), pre-fill currency from the account.
  useEffect(() => {
    if (mode !== "create") return;
    const account = accountsQ.data?.find((a) => a.id === form.account_id);
    if (account) {
      setForm((s) => ({ ...s, currency: account.currency }));
    }
  }, [form.account_id, accountsQ.data, mode]);

  const createMutation = useMutation<
    InvestmentHoldingRead,
    ApiError,
    InvestmentHoldingCreate
  >({
    mutationFn: (body) =>
      apiFetch<InvestmentHoldingRead>("/investments/holdings/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["investments-portfolio"],
      });
      navigate("/investments");
    },
    onError: (err) => setServerError(extractError(err)),
  });

  const updateMutation = useMutation<
    InvestmentHoldingRead,
    ApiError,
    InvestmentHoldingUpdate
  >({
    mutationFn: (body) =>
      apiFetch<InvestmentHoldingRead>(`/investments/holdings/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["investments-portfolio"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["investment-holding", id],
      });
      navigate("/investments");
    },
    onError: (err) => setServerError(extractError(err)),
  });

  const deleteMutation = useMutation<void, ApiError>({
    mutationFn: () =>
      apiFetch<void>(`/investments/holdings/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["investments-portfolio"],
      });
      navigate("/investments");
    },
    onError: (err) => setServerError(extractError(err)),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    if (!form.ticker.trim()) {
      setServerError("Ticker is required.");
      return;
    }
    if (mode === "create" && !form.account_id) {
      setServerError("Pick an account.");
      return;
    }

    if (mode === "create") {
      const body: InvestmentHoldingCreate = {
        account_id: form.account_id,
        ticker: form.ticker.trim().toUpperCase(),
        asset_class: form.asset_class,
        shares: form.shares,
        avg_cost: form.avg_cost,
        current_price: form.current_price,
        currency: form.currency.toUpperCase(),
        as_of: form.as_of,
        notes: form.notes.trim() || null,
      };
      createMutation.mutate(body);
    } else {
      const body: InvestmentHoldingUpdate = {
        ticker: form.ticker.trim().toUpperCase(),
        asset_class: form.asset_class,
        shares: form.shares,
        avg_cost: form.avg_cost,
        current_price: form.current_price,
        currency: form.currency.toUpperCase(),
        as_of: form.as_of,
        notes: form.notes.trim() || null,
      };
      updateMutation.mutate(body);
    }
  }

  const lockedAccount = mode === "edit";
  const isPending = createMutation.isPending || updateMutation.isPending;
  const accounts = accountsQ.data ?? [];

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">
            {mode === "create" ? "Add holding" : "Edit holding"}
          </h2>
          <Link
            to="/investments"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Back to overview
          </Link>
        </div>

        {mode === "edit" && holdingQ.isLoading && (
          <LoadingBox />
        )}

        {(mode === "create" || holdingQ.data) && (
          <Card>
            <CardContent className="p-4">
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="hf-account">Account</Label>
                    <select
                      id="hf-account"
                      value={form.account_id}
                      disabled={lockedAccount}
                      aria-describedby={
                        lockedAccount ? "hf-account-help" : undefined
                      }
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          account_id: e.target.value,
                        }))
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
                    >
                      <option value="" disabled>
                        — pick an account —
                      </option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} · {a.currency}
                        </option>
                      ))}
                    </select>
                    {lockedAccount && (
                      <p
                        id="hf-account-help"
                        className="text-xs text-muted-foreground"
                      >
                        Account is fixed. To move this holding, delete it
                        and re-add under the new account.
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-ticker">Ticker</Label>
                    <Input
                      id="hf-ticker"
                      value={form.ticker}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, ticker: e.target.value }))
                      }
                      placeholder="VEQT.TO"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-class">Asset class</Label>
                    <select
                      id="hf-class"
                      value={form.asset_class}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          asset_class: e.target.value as AssetClass,
                        }))
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {ASSET_CLASSES.map((c) => (
                        <option key={c} value={c}>
                          {labelForAssetClass(c)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-shares">Shares</Label>
                    <Input
                      id="hf-shares"
                      type="number"
                      step="0.00000001"
                      value={form.shares}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, shares: e.target.value }))
                      }
                      placeholder="100"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-currency">Currency</Label>
                    <Input
                      id="hf-currency"
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

                  <div className="space-y-1">
                    <Label htmlFor="hf-avg">Avg cost per share</Label>
                    <Input
                      id="hf-avg"
                      type="number"
                      step="0.0001"
                      value={form.avg_cost}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, avg_cost: e.target.value }))
                      }
                      placeholder="30.50"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-price">Current price per share</Label>
                    <Input
                      id="hf-price"
                      type="number"
                      step="0.0001"
                      value={form.current_price}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          current_price: e.target.value,
                        }))
                      }
                      placeholder="33.20"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hf-asof">Price as of</Label>
                    <Input
                      id="hf-asof"
                      type="date"
                      value={form.as_of}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, as_of: e.target.value }))
                      }
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="hf-notes">Notes</Label>
                    <Input
                      id="hf-notes"
                      value={form.notes}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, notes: e.target.value }))
                      }
                      placeholder="DRIP enabled, etc."
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button type="submit" disabled={isPending}>
                    {isPending
                      ? mode === "create"
                        ? "Adding…"
                        : "Saving…"
                      : mode === "create"
                      ? "Add holding"
                      : "Save changes"}
                  </Button>
                  {mode === "edit" && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (window.confirm("Delete this holding?")) {
                          deleteMutation.mutate();
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? "Deleting…" : "Delete"}
                    </Button>
                  )}
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
