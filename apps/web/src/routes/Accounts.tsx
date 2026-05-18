/**
 * Accounts — unified management page across all three sources.
 *
 * Reads GET /accounts (a union of ynab_accounts, manual_accounts, and
 * investment_accounts). The visual language mirrors the Money +
 * Business dashboards: top bar with a context action, a KPI strip with
 * totals, then a grouped list.
 *
 * Source-specific behaviour:
 *   - YNAB rows are read-only except for the kind/owner tags. The
 *     global "Sync YNAB" button at the top refreshes them in bulk.
 *   - Manual rows expand into an inline editor where the user can edit
 *     name, bank, balance, currency, kind, owner, notes.
 *   - Investment rows expand into a smaller inline editor for the
 *     uninvested cash position + the kind/owner tags. The actual
 *     equity holdings keep their existing UI under /investments.
 */
import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  AccountKind,
  AccountListResponse,
  AccountOwner,
  AccountRow,
  AccountSource,
  AccountTagsUpdate,
  ManualAccountCreate,
  ManualAccountKind,
  ManualAccountOwner,
  ManualAccountRead,
  ManualAccountUpdate,
  InvestmentAccountRead,
  YnabRefreshResponse,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const KIND_OPTIONS: { value: AccountKind; label: string }[] = [
  { value: "unassigned", label: "Unassigned" },
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "line_of_credit", label: "Line of credit" },
  { value: "investing_fund", label: "Investing — fund" },
  { value: "investing_stock", label: "Investing — stock" },
];

const OWNER_OPTIONS: { value: AccountOwner; label: string }[] = [
  { value: "unassigned", label: "Unassigned" },
  { value: "personal", label: "Personal" },
  { value: "business", label: "Business" },
];

const MANUAL_KIND_OPTIONS: { value: ManualAccountKind; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "line_of_credit", label: "Line of credit" },
];

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

function fmtMoney(v: number | string | null, currency: string): string {
  const n = num(v);
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}

function fmtAsOf(s: string | null): string {
  if (!s) return "never";
  // YYYY-MM-DD → relative
  return fmtRelative(`${s}T00:00:00`);
}

function sourceBadge(source: AccountSource): string {
  return source === "ynab"
    ? "YNAB"
    : source === "manual"
      ? "Manual"
      : "Investment";
}

function labelForKind(kind: AccountKind): string {
  return (
    KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "Unassigned"
  );
}

function labelForOwner(owner: AccountOwner): string {
  return (
    OWNER_OPTIONS.find((o) => o.value === owner)?.label ?? "Unassigned"
  );
}

/** Strip the namespacing prefix so we can pass the raw id to the API. */
function unwrapId(rowId: string): string {
  const colon = rowId.indexOf(":");
  return colon === -1 ? rowId : rowId.slice(colon + 1);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Accounts() {
  const queryClient = useQueryClient();
  const accountsQuery = useQuery<AccountListResponse>({
    queryKey: ["accounts"],
    queryFn: () => apiFetch<AccountListResponse>("/accounts"),
  });

  const syncMutation = useMutation<YnabRefreshResponse, ApiError, void>({
    mutationFn: () =>
      apiFetch<YnabRefreshResponse>("/accounts/ynab/sync", {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const tagsMutation = useMutation<
    AccountRow,
    ApiError,
    { row: AccountRow; tags: AccountTagsUpdate }
  >({
    mutationFn: ({ row, tags }) =>
      apiFetch<AccountRow>(
        `/accounts/${row.source}/${unwrapId(row.id)}/tags`,
        { method: "PATCH", body: JSON.stringify(tags) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddManual, setShowAddManual] = useState(false);

  const rows = accountsQuery.data?.accounts ?? [];
  const groups = useMemo(() => groupByOwner(rows), [rows]);

  const totalCadByOwner = useMemo(() => {
    const t: Record<AccountOwner, number> = {
      personal: 0,
      business: 0,
      unassigned: 0,
    };
    for (const r of rows) {
      if (r.balance_cad !== null && r.balance_cad !== undefined) {
        t[r.owner] += num(r.balance_cad);
      }
    }
    return t;
  }, [rows]);

  const lastSyncedAt = useMemo(() => {
    const ynabRows = rows.filter((r) => r.source === "ynab");
    if (ynabRows.length === 0) return null;
    return ynabRows.reduce<string | null>((latest, r) => {
      if (!r.last_synced_at) return latest;
      if (!latest || r.last_synced_at > latest) return r.last_synced_at;
      return latest;
    }, null);
  }, [rows]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Accounts
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every cash and investment account, across YNAB, manual
              entries, and your brokerage rows.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              YNAB last synced: {fmtRelative(lastSyncedAt)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
            >
              {syncMutation.isPending ? "Syncing…" : "Sync YNAB"}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setShowAddManual((s) => !s)}
            >
              {showAddManual ? "Cancel" : "Add manual account"}
            </Button>
          </div>
        </header>

        {syncMutation.isError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Sync failed: {extractError(syncMutation.error)}
          </div>
        )}

        {/* Totals strip */}
        <section className="mb-6 grid gap-3 sm:grid-cols-3">
          <TotalCard label="Personal" amount={totalCadByOwner.personal} />
          <TotalCard label="Business" amount={totalCadByOwner.business} />
          <TotalCard
            label="Unassigned"
            amount={totalCadByOwner.unassigned}
            muted
          />
        </section>

        {showAddManual && (
          <Card className="mb-6 border-primary/40">
            <CardContent className="pt-6">
              <ManualAccountForm
                onCancel={() => setShowAddManual(false)}
                onSaved={() => {
                  setShowAddManual(false);
                  void queryClient.invalidateQueries({
                    queryKey: ["accounts"],
                  });
                }}
              />
            </CardContent>
          </Card>
        )}

        {accountsQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading accounts…</p>
        )}
        {accountsQuery.isError && (
          <p className="text-sm text-destructive">
            Failed to load: {extractError(accountsQuery.error)}
          </p>
        )}

        {(["personal", "business", "unassigned"] as AccountOwner[]).map(
          (owner) => {
            const ownerRows = groups[owner];
            if (!ownerRows || ownerRows.length === 0) return null;
            return (
              <section key={owner} className="mb-8">
                <h2 className="mb-3 text-lg font-medium">
                  {labelForOwner(owner)}
                </h2>
                <Card>
                  <CardContent className="p-0">
                    <ul className="divide-y">
                      {ownerRows.map((row) => (
                        <AccountRowItem
                          key={row.id}
                          row={row}
                          isEditing={editingId === row.id}
                          onToggleEdit={() =>
                            setEditingId((cur) =>
                              cur === row.id ? null : row.id,
                            )
                          }
                          onChangeTag={(tags) =>
                            tagsMutation.mutate({ row, tags })
                          }
                          onSaved={() => {
                            setEditingId(null);
                            void queryClient.invalidateQueries({
                              queryKey: ["accounts"],
                            });
                          }}
                        />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </section>
            );
          },
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TotalCard({
  label,
  amount,
  muted,
}: {
  label: string;
  amount: number;
  muted?: boolean;
}) {
  return (
    <Card className={muted ? "opacity-70" : ""}>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold">
          {fmtMoney(amount, "CAD")}
        </p>
      </CardContent>
    </Card>
  );
}

function AccountRowItem({
  row,
  isEditing,
  onToggleEdit,
  onChangeTag,
  onSaved,
}: {
  row: AccountRow;
  isEditing: boolean;
  onToggleEdit: () => void;
  onChangeTag: (tags: AccountTagsUpdate) => void;
  onSaved: () => void;
}) {
  const balanceCad =
    row.balance_cad === null
      ? null
      : fmtMoney(row.balance_cad, "CAD");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{row.name}</span>
            <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {sourceBadge(row.source)}
            </span>
            {row.bank && (
              <span className="truncate text-xs text-muted-foreground">
                · {row.bank}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.source === "ynab"
              ? `Synced ${fmtRelative(row.last_synced_at)}`
              : `As of ${fmtAsOf(row.balance_as_of)}`}
            {row.source === "investment" &&
              typeof row.extra?.["holdings_count"] === "number" && (
                <>
                  {" · "}
                  {row.extra["holdings_count"] as number} holding(s)
                </>
              )}
          </p>
        </div>

        <div className="flex flex-col items-end">
          <span className="font-mono text-sm font-medium">
            {fmtMoney(row.balance, row.currency)}
          </span>
          {row.currency !== "CAD" && (
            <span className="text-xs text-muted-foreground">
              {balanceCad ?? "FX unavailable"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={row.kind}
            onChange={(e) =>
              onChangeTag({ kind: e.target.value as AccountKind })
            }
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={row.owner}
            onChange={(e) =>
              onChangeTag({ owner: e.target.value as AccountOwner })
            }
          >
            {OWNER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {row.is_editable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onToggleEdit}
            >
              {isEditing ? "Close" : "Edit"}
            </Button>
          )}
          {row.source === "investment" && row.kind === "investing_stock" && (
            <Link
              to={`/investments/accounts`}
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              View holdings →
            </Link>
          )}
        </div>
      </div>

      {isEditing && row.source === "manual" && (
        <div className="mt-4 rounded-md border bg-muted/30 p-4">
          <ManualAccountForm
            existingId={unwrapId(row.id)}
            initial={row}
            onCancel={onToggleEdit}
            onSaved={onSaved}
          />
        </div>
      )}
      {isEditing && row.source === "investment" && (
        <div className="mt-4 rounded-md border bg-muted/30 p-4">
          <InvestmentAccountInlineForm
            existingId={unwrapId(row.id)}
            row={row}
            onCancel={onToggleEdit}
            onSaved={onSaved}
          />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Manual account form (create + edit)
// ---------------------------------------------------------------------------

function ManualAccountForm({
  existingId,
  initial,
  onCancel,
  onSaved,
}: {
  existingId?: string;
  initial?: AccountRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [bank, setBank] = useState(initial?.bank ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "BRL");
  const [balance, setBalance] = useState(
    initial ? String(initial.balance) : "0",
  );
  const [kind, setKind] = useState<ManualAccountKind>(
    (initial?.kind as ManualAccountKind) ?? "checking",
  );
  const [owner, setOwner] = useState<ManualAccountOwner>(
    (initial?.owner as ManualAccountOwner) ?? "personal",
  );
  const [notes, setNotes] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const isEdit = Boolean(existingId);

  const mutation = useMutation<ManualAccountRead, ApiError, void>({
    mutationFn: () => {
      const body: ManualAccountCreate | ManualAccountUpdate = {
        name,
        bank: bank || null,
        currency: currency.toUpperCase(),
        balance,
        kind,
        owner,
        notes: notes || null,
      };
      return apiFetch<ManualAccountRead>(
        isEdit
          ? `/accounts/manual/${existingId}`
          : "/accounts/manual",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify(body),
        },
      );
    },
    onSuccess: () => {
      setServerError(null);
      onSaved();
    },
    onError: (err) => setServerError(extractError(err)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <div>
        <Label htmlFor="ma-name">Name</Label>
        <Input
          id="ma-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="ma-bank">Bank</Label>
        <Input
          id="ma-bank"
          value={bank ?? ""}
          onChange={(e) => setBank(e.target.value)}
          placeholder="Itaú, Bradesco, …"
        />
      </div>
      <div>
        <Label htmlFor="ma-balance">Balance</Label>
        <Input
          id="ma-balance"
          type="number"
          step="0.01"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="ma-currency">Currency</Label>
        <Input
          id="ma-currency"
          value={currency}
          maxLength={3}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
      </div>
      <div>
        <Label htmlFor="ma-kind">Kind</Label>
        <select
          id="ma-kind"
          className="block h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as ManualAccountKind)
          }
        >
          {MANUAL_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="ma-owner">Owner</Label>
        <select
          id="ma-owner"
          className="block h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={owner}
          onChange={(e) =>
            setOwner(e.target.value as ManualAccountOwner)
          }
        >
          <option value="personal">Personal</option>
          <option value="business">Business</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="ma-notes">Notes</Label>
        <Input
          id="ma-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      {serverError && (
        <p className="sm:col-span-2 text-sm text-destructive">
          {serverError}
        </p>
      )}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Investment account inline form (edit only — create lives elsewhere)
// ---------------------------------------------------------------------------

function InvestmentAccountInlineForm({
  existingId,
  row,
  onCancel,
  onSaved,
}: {
  existingId: string;
  row: AccountRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const initialCash = (row.extra?.["cash_balance"] as number) ?? 0;
  const initialCashCcy =
    (row.extra?.["cash_currency"] as string) ?? row.currency;

  const [name, setName] = useState(row.name);
  const [bank, setBank] = useState(row.bank ?? "");
  const [cashBalance, setCashBalance] = useState(String(initialCash));
  const [cashCurrency, setCashCurrency] = useState(initialCashCcy);
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = useMutation<InvestmentAccountRead, ApiError, void>({
    mutationFn: () =>
      apiFetch<InvestmentAccountRead>(
        `/investments/accounts/${existingId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name,
            bank: bank || null,
            cash_balance: cashBalance,
            cash_currency: cashCurrency.toUpperCase(),
          }),
        },
      ),
    onSuccess: () => {
      setServerError(null);
      onSaved();
    },
    onError: (err) => setServerError(extractError(err)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <div>
        <Label htmlFor="ia-name">Name</Label>
        <Input
          id="ia-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="ia-bank">Brokerage / bank</Label>
        <Input
          id="ia-bank"
          value={bank}
          onChange={(e) => setBank(e.target.value)}
          placeholder="Scotia iTrade, Itaú Investimentos, …"
        />
      </div>
      <div>
        <Label htmlFor="ia-cash">Cash balance</Label>
        <Input
          id="ia-cash"
          type="number"
          step="0.01"
          value={cashBalance}
          onChange={(e) => setCashBalance(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Uninvested cash sitting in the brokerage account.
        </p>
      </div>
      <div>
        <Label htmlFor="ia-cash-ccy">Cash currency</Label>
        <Input
          id="ia-cash-ccy"
          value={cashCurrency}
          maxLength={3}
          onChange={(e) =>
            setCashCurrency(e.target.value.toUpperCase())
          }
        />
      </div>
      {serverError && (
        <p className="sm:col-span-2 text-sm text-destructive">
          {serverError}
        </p>
      )}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function groupByOwner(
  rows: AccountRow[],
): Record<AccountOwner, AccountRow[]> {
  const out: Record<AccountOwner, AccountRow[]> = {
    personal: [],
    business: [],
    unassigned: [],
  };
  for (const r of rows) out[r.owner].push(r);
  return out;
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | null;
    const d = body && typeof body === "object" ? body.detail : null;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) {
      return String((d as { message: unknown }).message);
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
