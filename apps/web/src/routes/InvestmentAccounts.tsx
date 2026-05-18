/**
 * InvestmentAccounts — list + create + edit + archive investment
 * accounts. Inline edit-by-row pattern (modal-free) to match the
 * Business Clients page.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  InvestmentAccountCreate,
  InvestmentAccountKind,
  InvestmentAccountRead,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ACCOUNT_KINDS,
  labelForAccountKind,
} from "@/lib/accountKind";

const DEFAULT_CURRENCY_FOR_KIND: Record<InvestmentAccountKind, string> = {
  itrade: "CAD",
  rrsp: "CAD",
  tfsa: "CAD",
  brazil: "BRL",
  corp: "CAD",
};

interface FormState {
  name: string;
  kind: InvestmentAccountKind;
  currency: string;
  owner_label: string;
  contribution_limit: string;
  notes: string;
  is_active: boolean;
}

function emptyForm(): FormState {
  return {
    name: "",
    kind: "itrade",
    currency: "CAD",
    owner_label: "",
    contribution_limit: "",
    notes: "",
    is_active: true,
  };
}

export function InvestmentAccounts() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<
    InvestmentAccountRead[]
  >({
    queryKey: ["investment-accounts"],
    queryFn: () =>
      apiFetch<InvestmentAccountRead[]>("/investments/accounts/"),
  });

  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Keep currency in sync with kind unless the user has manually changed it.
  function patchKind(kind: InvestmentAccountKind) {
    setForm((s) => ({
      ...s,
      kind,
      currency: DEFAULT_CURRENCY_FOR_KIND[kind],
    }));
  }

  const createMutation = useMutation<
    InvestmentAccountRead,
    ApiError,
    InvestmentAccountCreate
  >({
    mutationFn: (body) =>
      apiFetch<InvestmentAccountRead>("/investments/accounts/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setForm(emptyForm());
      setServerError(null);
      void queryClient.invalidateQueries({ queryKey: ["investment-accounts"] });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  const updateMutation = useMutation<
    InvestmentAccountRead,
    ApiError,
    { id: string; body: Partial<InvestmentAccountCreate> }
  >({
    mutationFn: ({ id, body }) =>
      apiFetch<InvestmentAccountRead>(`/investments/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setEditingId(null);
      setForm(emptyForm());
      setServerError(null);
      void queryClient.invalidateQueries({ queryKey: ["investment-accounts"] });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  const deleteMutation = useMutation<void, ApiError, string>({
    mutationFn: (id) =>
      apiFetch<void>(`/investments/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["investment-accounts"] });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  function startEdit(account: InvestmentAccountRead) {
    setEditingId(account.id);
    setForm({
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      owner_label: account.owner_label ?? "",
      contribution_limit:
        account.contribution_limit !== null &&
        account.contribution_limit !== undefined
          ? String(account.contribution_limit)
          : "",
      notes: account.notes ?? "",
      is_active: account.is_active,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
    setServerError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const body: InvestmentAccountCreate = {
      name: form.name.trim(),
      kind: form.kind,
      currency: form.currency.toUpperCase(),
      owner_label: form.owner_label.trim() || null,
      contribution_limit: form.contribution_limit.trim() || null,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, body });
    } else {
      createMutation.mutate(body);
    }
  }

  // Auto-clear "server says you have holdings" errors when the user
  // navigates away from the row that triggered them.
  useEffect(() => {
    if (!editingId) return;
    setServerError(null);
  }, [editingId]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Accounts</h2>
            <p className="text-sm text-muted-foreground">
              One row per real-world account — Scotia iTrade, RRSP, TFSA,
              Brazilian, or corp.
            </p>
          </div>
          <Link
            to="/investments"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Back to overview
          </Link>
        </div>

        <Card className="mb-6">
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {editingId ? "Edit account" : "New account"}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="acc-name">Name</Label>
                  <Input
                    id="acc-name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, name: e.target.value }))
                    }
                    placeholder="iTrade Personal"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="acc-kind">Type</Label>
                  <select
                    id="acc-kind"
                    value={form.kind}
                    onChange={(e) =>
                      patchKind(e.target.value as InvestmentAccountKind)
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {ACCOUNT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {labelForAccountKind(k)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="acc-currency">Currency</Label>
                  <Input
                    id="acc-currency"
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
                  <Label htmlFor="acc-owner">Owner label (optional)</Label>
                  <Input
                    id="acc-owner"
                    value={form.owner_label}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, owner_label: e.target.value }))
                    }
                    placeholder="Joint with spouse"
                  />
                </div>
                {(form.kind === "rrsp" || form.kind === "tfsa") && (
                  <div className="space-y-1">
                    <Label htmlFor="acc-limit">Contribution room</Label>
                    <Input
                      id="acc-limit"
                      type="number"
                      step="0.01"
                      value={form.contribution_limit}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          contribution_limit: e.target.value,
                        }))
                      }
                      placeholder={form.kind === "tfsa" ? "7000.00" : "31560.00"}
                    />
                  </div>
                )}
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="acc-notes">Notes</Label>
                  <Input
                    id="acc-notes"
                    value={form.notes}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, notes: e.target.value }))
                    }
                    placeholder="Anything you want to remember"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  disabled={
                    !form.name.trim() ||
                    createMutation.isPending ||
                    updateMutation.isPending
                  }
                >
                  {editingId
                    ? updateMutation.isPending
                      ? "Saving…"
                      : "Save changes"
                    : createMutation.isPending
                    ? "Adding…"
                    : "Add account"}
                </Button>
                {editingId && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={cancelEdit}
                  >
                    Cancel
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

        {isLoading && (
          <p className="text-muted-foreground">Loading accounts…</p>
        )}
        {isError && (
          <p className="text-destructive">
            Failed to load: {error instanceof Error ? error.message : "?"}
          </p>
        )}
        {data && data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No accounts yet. Add your first above.
          </p>
        )}
        {data && data.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium">Name</th>
                    <th className="py-2 text-left font-medium">Type</th>
                    <th className="py-2 text-left font-medium">Currency</th>
                    <th className="py-2 text-right font-medium">
                      Contribution
                    </th>
                    <th className="py-2 text-left font-medium">Status</th>
                    <th className="py-2 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="py-2 font-medium">{a.name}</td>
                      <td className="py-2 text-muted-foreground">
                        {labelForAccountKind(a.kind)}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {a.currency}
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {a.contribution_limit !== null &&
                        a.contribution_limit !== undefined
                          ? new Intl.NumberFormat("en-CA", {
                              style: "currency",
                              currency: a.currency,
                              maximumFractionDigits: 0,
                            }).format(Number(a.contribution_limit))
                          : "—"}
                      </td>
                      <td className="py-2">
                        {a.is_active ? (
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">
                            active
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            archived
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Link
                            to={`/investments/accounts/${a.id}/contributions`}
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            deposits
                          </Link>
                          <button
                            type="button"
                            onClick={() => startEdit(a)}
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Delete account "${a.name}"? This fails if any holdings still reference it.`,
                                )
                              ) {
                                deleteMutation.mutate(a.id);
                              }
                            }}
                            className="text-xs text-destructive underline-offset-2 hover:underline"
                          >
                            delete
                          </button>
                        </div>
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
