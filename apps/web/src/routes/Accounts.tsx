/**
 * Accounts — unified management page across YNAB-synced and manual
 * sources.
 *
 * Reads GET /accounts (a union of ynab_accounts and manual_accounts).
 * The visual language mirrors the Money + Business dashboards: top bar
 * with a context action, a KPI strip with totals, then a grouped list.
 *
 * Source-specific behaviour:
 *   - YNAB rows are read-only except for the kind/owner tags. The
 *     global "Sync YNAB" button at the top refreshes them in bulk.
 *   - Manual rows expand into an inline editor where the user can edit
 *     name, bank, balance, currency, kind, owner, notes.
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
  YnabRefreshResponse,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingBox } from "@/components/LoadingScreen";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const KIND_OPTIONS: { value: AccountKind; label: string }[] = [
  { value: "unassigned", label: "Unassigned" },
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit card" },
  { value: "line_of_credit", label: "Line of credit / mortgage" },
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
  { value: "credit_card", label: "Credit card" },
  { value: "line_of_credit", label: "Line of credit / mortgage" },
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
  return source === "ynab" ? "YNAB" : "Manual";
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

  const deleteMutation = useMutation<void, ApiError, AccountRow>({
    mutationFn: (row) => {
      // YNAB rows are unrouted here — the button is hidden for them.
      const path =
        row.source === "manual"
          ? `/accounts/manual/${unwrapId(row.id)}`
          : `/investments/accounts/${unwrapId(row.id)}`;
      return apiFetch<void>(path, { method: "DELETE" });
    },
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
      <main className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-bold">Accounts</h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs text-muted-foreground">
                YNAB synced{" "}
                <span className="font-medium text-foreground">
                  {fmtRelative(lastSyncedAt)}
                </span>
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
              <Button asChild type="button" variant="outline" size="sm">
                <Link to="/investments/accounts">Add brokerage</Link>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setShowAddManual((s) => !s)}
              >
                {showAddManual ? "Cancel" : "Add cash account"}
              </Button>
            </div>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Every cash and investment account, across YNAB, manual
            entries, and your brokerage rows.
          </p>
        </header>

        {syncMutation.isError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Sync failed: {extractError(syncMutation.error)}
          </div>
        )}

        {/* Totals strip */}
        <section className="mb-6">
          <h3 className="mb-3 text-sm font-semibold">Totals (CAD)</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TotalCard
              label="Personal"
              amount={totalCadByOwner.personal}
              detail={`${groups.personal?.length ?? 0} account${
                (groups.personal?.length ?? 0) === 1 ? "" : "s"
              }`}
              valueClass="text-emerald-600 dark:text-emerald-400"
            />
            <TotalCard
              label="Business"
              amount={totalCadByOwner.business}
              detail={`${groups.business?.length ?? 0} account${
                (groups.business?.length ?? 0) === 1 ? "" : "s"
              }`}
              valueClass="text-foreground"
            />
            <TotalCard
              label="Unassigned"
              amount={totalCadByOwner.unassigned}
              detail={`${groups.unassigned?.length ?? 0} account${
                (groups.unassigned?.length ?? 0) === 1 ? "" : "s"
              }`}
              muted
            />
          </div>
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
          <LoadingBox />
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
            const ownerCount = ownerRows.length;
            return (
              <section key={owner} className="mb-6">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">
                    {labelForOwner(owner)}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {ownerCount} account{ownerCount === 1 ? "" : "s"}
                  </span>
                </div>
                <Card>
                  <CardContent className="p-0">
                    <ul className="divide-y">
                      {ownerRows.map((row) => (
                        <AccountRowItem
                          key={row.id}
                          row={row}
                          isEditing={editingId === row.id}
                          isDeleting={
                            deleteMutation.isPending &&
                            deleteMutation.variables?.id === row.id
                          }
                          onToggleEdit={() =>
                            setEditingId((cur) =>
                              cur === row.id ? null : row.id,
                            )
                          }
                          onChangeTag={(tags) =>
                            tagsMutation.mutate({ row, tags })
                          }
                          onDelete={() => {
                            if (
                              confirm(
                                `Delete "${row.name}"? This cannot be undone.`,
                              )
                            ) {
                              deleteMutation.mutate(row);
                            }
                          }}
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
  detail,
  valueClass,
  muted,
}: {
  label: string;
  amount: number;
  detail?: string;
  valueClass?: string;
  muted?: boolean;
}) {
  return (
    <Card className={"h-full " + (muted ? "opacity-70" : "")}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={
            "text-2xl font-bold " +
            (muted
              ? "text-muted-foreground"
              : (valueClass ?? "text-foreground"))
          }
        >
          {fmtMoney(amount, "CAD")}
        </p>
        {detail && (
          <p className="text-xs text-muted-foreground">{detail}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AccountRowItem({
  row,
  isEditing,
  isDeleting,
  onToggleEdit,
  onChangeTag,
  onDelete,
  onSaved,
}: {
  row: AccountRow;
  isEditing: boolean;
  isDeleting: boolean;
  onToggleEdit: () => void;
  onChangeTag: (tags: AccountTagsUpdate) => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const balanceCad =
    row.balance_cad === null
      ? null
      : fmtMoney(row.balance_cad, "CAD");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{row.name}</span>
            <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {sourceBadge(row.source)}
            </span>
            {row.bank && (
              <span className="truncate text-xs text-muted-foreground">
                {row.bank}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.source === "ynab"
              ? `Synced ${fmtRelative(row.last_synced_at)}`
              : `As of ${fmtAsOf(row.balance_as_of)}`}
          </p>
        </div>

        {/* Balance */}
        <div className="flex flex-col items-start lg:w-32 lg:items-end">
          <span className="font-mono text-sm font-medium">
            {fmtMoney(row.balance, row.currency)}
          </span>
          {row.currency !== "CAD" && (
            <span className="text-xs text-muted-foreground">
              {balanceCad ?? "FX unavailable"}
            </span>
          )}
        </div>

        {/* Tag controls + edit */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Kind"
            className="h-9 rounded-md border bg-background px-2 text-xs"
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
            aria-label="Owner"
            className="h-9 rounded-md border bg-background px-2 text-xs"
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
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onToggleEdit}
              >
                {isEditing ? "Close" : "Edit"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onDelete}
                disabled={isDeleting}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Delete ${row.name}`}
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </Button>
            </>
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
