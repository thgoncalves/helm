/**
 * PersonalTransactions — per-account list of imported transactions.
 *
 * Filters: account (required for the API call to be useful), date range,
 * and category. Client-side text search across description.
 *
 * Click a row to inline-edit the category (PATCH). Description and
 * amount stay read-only — rewriting either would defeat the dedup
 * invariant on the table.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  PersonalAccountRead,
  PersonalTransactionRead,
} from "@/types/api";
import { formatCAD, num } from "@/lib/invoice";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

// V1 category options — same flavour as the Expenses page.
const CATEGORIES = [
  "Groceries",
  "Eating Out",
  "Coffee",
  "Transport",
  "Fuel",
  "Subscriptions",
  "Shopping",
  "Bills & Utilities",
  "Rent",
  "Income",
  "Transfer",
  "Other",
];

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function PersonalTransactions() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const accountsQuery = useQuery<PersonalAccountRead[]>({
    queryKey: ["personal-accounts", true],
    queryFn: () =>
      apiFetch<PersonalAccountRead[]>(
        "/personal/accounts/?include_archived=true",
      ),
  });

  // Auto-pick the first active account once they load.
  useMemo(() => {
    if (!accountId && accountsQuery.data && accountsQuery.data.length > 0) {
      const first = accountsQuery.data.find((a) => a.is_active);
      if (first) setAccountId(first.id);
    }
  }, [accountId, accountsQuery.data]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (accountId) p.set("account_id", accountId);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (categoryFilter !== "all") p.set("category", categoryFilter);
    return p.toString();
  }, [accountId, from, to, categoryFilter]);

  const transactionsQuery = useQuery<PersonalTransactionRead[]>({
    queryKey: ["personal-transactions", qs],
    queryFn: () =>
      apiFetch<PersonalTransactionRead[]>(
        `/personal/transactions/${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!accountId,
  });

  const categoryMutation = useMutation<
    PersonalTransactionRead,
    ApiError,
    { id: string; category: string }
  >({
    mutationFn: ({ id, category }) =>
      apiFetch<PersonalTransactionRead>(`/personal/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ category: category || null }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["personal-transactions"],
      });
    },
  });

  const rows = transactionsQuery.data ?? [];
  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((t) => t.description.toLowerCase().includes(q));
  }, [rows, search]);

  // Running net for the visible filtered window (helpful sanity check).
  const total = useMemo(
    () => filtered.reduce((sum, t) => sum + num(t.amount), 0),
    [filtered],
  );

  const selectedAccount = (accountsQuery.data ?? []).find(
    (a) => a.id === accountId,
  );

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Transactions</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => navigate("/personal/accounts")}
            >
              Accounts
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate("/personal/imports")}
            >
              Imports
            </Button>
          </div>
        </div>

        {/* Filter row */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-4 py-3 text-sm">
          <label htmlFor="account">Account:</label>
          <select
            id="account"
            className={`${SELECT_CLASSES} w-56`}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">Select…</option>
            {(accountsQuery.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.is_active ? "" : " (archived)"}
              </option>
            ))}
          </select>

          <label className="ml-2">From:</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-40"
          />
          <label>To:</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-40"
          />

          <label className="ml-2">Category:</label>
          <select
            className={`${SELECT_CLASSES} w-40`}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search transactions"
          />
          <Button
            variant="outline"
            onClick={() => setSearch("")}
            disabled={!search}
          >
            Clear
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {!accountId && (
              <p className="p-6 text-muted-foreground">
                Pick an account to see its transactions.
              </p>
            )}
            {accountId && transactionsQuery.isLoading && (
              <p className="p-6 text-muted-foreground">Loading…</p>
            )}
            {accountId && rows.length === 0 && !transactionsQuery.isLoading && (
              <p className="p-6 text-muted-foreground">
                No transactions for this filter. Upload a CSV from the
                Imports page.
              </p>
            )}
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Description</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Amount
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Balance
                      </th>
                      <th className="px-4 py-2 font-semibold">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => {
                      const amount = num(t.amount);
                      const positive = amount > 0;
                      return (
                        <tr key={t.id} className="border-b last:border-0">
                          <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                            {formatDate(t.posted_date)}
                          </td>
                          <td className="px-4 py-2">{t.description}</td>
                          <td
                            className={
                              "whitespace-nowrap px-4 py-2 text-right font-semibold " +
                              (positive
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-foreground")
                            }
                          >
                            {formatCAD(amount)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 text-right text-muted-foreground">
                            {t.balance != null ? formatCAD(num(t.balance)) : "—"}
                          </td>
                          <td className="px-4 py-2">
                            <select
                              className={`${SELECT_CLASSES} max-w-[180px]`}
                              value={t.category ?? ""}
                              onChange={(e) =>
                                categoryMutation.mutate({
                                  id: t.id,
                                  category: e.target.value,
                                })
                              }
                            >
                              <option value="">—</option>
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
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

        {filtered.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-2 px-1 text-sm">
            <p className="text-muted-foreground">
              {filtered.length} transaction{filtered.length === 1 ? "" : "s"}
              {selectedAccount ? ` on ${selectedAccount.name}` : ""}
            </p>
            <p>
              Net:{" "}
              <span
                className={
                  "font-semibold " +
                  (total >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400")
                }
              >
                {formatCAD(total)}
              </span>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
