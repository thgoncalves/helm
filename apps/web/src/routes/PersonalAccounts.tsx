/**
 * PersonalAccounts — list + archive personal accounts.
 *
 * Inline editing — the table rows are clickable and a modal-style edit
 * view inside the same page handles add/edit/archive. Deletion only
 * succeeds when no transactions reference the account; otherwise the
 * backend returns 409 with a hint to archive instead.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  Institution,
  PersonalAccountCreate,
  PersonalAccountRead,
  PersonalAccountType,
} from "@/types/api";
import { formatCAD, num } from "@/lib/invoice";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const INSTITUTIONS: Institution[] = ["RBC", "TD", "Scotia", "Other"];
const ACCOUNT_TYPES: { value: PersonalAccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "cash", label: "Cash" },
];

function labelFor(type: PersonalAccountType): string {
  return ACCOUNT_TYPES.find((t) => t.value === type)?.label ?? type;
}

function blankForm(): PersonalAccountCreate {
  return {
    name: "",
    institution: "RBC",
    account_type: "checking",
    currency: "CAD",
    opening_balance: "0",
    is_active: true,
    notes: null,
  };
}

function fromAccount(a: PersonalAccountRead): PersonalAccountCreate {
  return {
    name: a.name,
    institution: a.institution,
    account_type: a.account_type,
    currency: a.currency,
    opening_balance:
      a.opening_balance != null ? String(a.opening_balance) : "0",
    is_active: a.is_active,
    notes: a.notes,
  };
}

export function PersonalAccounts() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<PersonalAccountRead | "new" | null>(
    null,
  );
  const [form, setForm] = useState<PersonalAccountCreate>(blankForm);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery<
    PersonalAccountRead[]
  >({
    queryKey: ["personal-accounts", showArchived],
    queryFn: () =>
      apiFetch<PersonalAccountRead[]>(
        `/personal/accounts/${showArchived ? "?include_archived=true" : ""}`,
      ),
  });

  const saveMutation = useMutation<
    PersonalAccountRead,
    ApiError,
    PersonalAccountCreate
  >({
    mutationFn: async (body) => {
      if (editing === "new" || editing === null) {
        return apiFetch<PersonalAccountRead>("/personal/accounts/", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      return apiFetch<PersonalAccountRead>(
        `/personal/accounts/${editing.id}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["personal-accounts"],
      });
      setEditing(null);
      setFormError(null);
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : String(err),
      );
    },
  });

  const deleteMutation = useMutation<void, ApiError, string>({
    mutationFn: (id) =>
      apiFetch(`/personal/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["personal-accounts"],
      });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError &&
        typeof err.body === "object" &&
        err.body &&
        "detail" in err.body
          ? String((err.body as { detail: unknown }).detail)
          : String(err);
      window.alert(message);
    },
  });

  const accounts = useMemo(() => data ?? [], [data]);

  function startNew() {
    setForm(blankForm());
    setEditing("new");
    setFormError(null);
  }

  function startEdit(a: PersonalAccountRead) {
    setForm(fromAccount(a));
    setEditing(a);
    setFormError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    saveMutation.mutate(form);
  }

  function handleArchiveToggle(a: PersonalAccountRead) {
    saveMutation.mutate({
      ...fromAccount(a),
      is_active: !a.is_active,
    });
  }

  function handleDelete(a: PersonalAccountRead) {
    if (
      !window.confirm(
        `Delete "${a.name}"? Only allowed when no transactions reference it — otherwise archive instead.`,
      )
    ) {
      return;
    }
    deleteMutation.mutate(a.id);
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Accounts</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("/personal/imports")}>
              Imports
            </Button>
            <Button variant="outline" onClick={() => navigate("/personal/transactions")}>
              Transactions
            </Button>
            <Button onClick={startNew}>New Account</Button>
          </div>
        </div>

        <div className="mb-3 flex items-center gap-2 text-sm">
          <input
            id="show-archived"
            type="checkbox"
            className="h-4 w-4"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <label htmlFor="show-archived" className="cursor-pointer">
            Show archived
          </label>
        </div>

        <Card>
          <CardContent className="p-0">
            {isLoading && (
              <p className="p-6 text-muted-foreground">Loading accounts…</p>
            )}
            {isError && (
              <p className="p-6 text-destructive">
                Failed to load:{" "}
                {error instanceof Error ? error.message : "Unknown"}
              </p>
            )}
            {!isLoading && !isError && accounts.length === 0 && (
              <p className="p-6 text-muted-foreground">
                No accounts yet. Tap "New Account" to add one.
              </p>
            )}
            {accounts.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-4 py-2 font-semibold">Institution</th>
                      <th className="px-4 py-2 font-semibold">Type</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Opening
                      </th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr
                        key={a.id}
                        className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                        onClick={() => startEdit(a)}
                      >
                        <td className="px-4 py-2 font-medium">{a.name}</td>
                        <td className="px-4 py-2">{a.institution}</td>
                        <td className="px-4 py-2">{labelFor(a.account_type)}</td>
                        <td className="px-4 py-2 text-right">
                          {formatCAD(num(a.opening_balance))}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={
                              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
                              (a.is_active
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                                : "bg-muted text-muted-foreground")
                            }
                          >
                            {a.is_active ? "Active" : "Archived"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <button
                            type="button"
                            className="mr-3 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleArchiveToggle(a);
                            }}
                          >
                            {a.is_active ? "Archive" : "Unarchive"}
                          </button>
                          <button
                            type="button"
                            className="text-sm text-destructive underline-offset-2 hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(a);
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {editing !== null && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">
                {editing === "new" ? "New account" : "Edit account"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleSubmit}
                className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_1fr] sm:items-center"
              >
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  required
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                />

                <Label htmlFor="institution">Institution</Label>
                <select
                  id="institution"
                  className={SELECT_CLASSES}
                  value={form.institution}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      institution: e.target.value as Institution,
                    })
                  }
                >
                  {INSTITUTIONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>

                <Label htmlFor="account_type">Type</Label>
                <select
                  id="account_type"
                  className={SELECT_CLASSES}
                  value={form.account_type}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      account_type: e.target.value as PersonalAccountType,
                    })
                  }
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>

                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      currency: e.target.value.toUpperCase(),
                    })
                  }
                />

                <Label htmlFor="opening_balance">Opening Balance</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="opening_balance"
                    type="number"
                    step="0.01"
                    className="pl-6"
                    value={String(form.opening_balance ?? "0")}
                    onChange={(e) =>
                      setForm({ ...form, opening_balance: e.target.value })
                    }
                  />
                </div>

                <Label htmlFor="notes" className="self-start pt-2">
                  Notes
                </Label>
                <textarea
                  id="notes"
                  rows={2}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={form.notes ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, notes: e.target.value || null })
                  }
                />

                {formError && (
                  <p className="text-sm text-destructive sm:col-span-2">
                    {formError}
                  </p>
                )}

                <div className="flex justify-end gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      setFormError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={saveMutation.isPending}>
                    {saveMutation.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
