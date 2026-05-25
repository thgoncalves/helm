/**
 * Accounts — Atlas layout (master-detail with a portfolio treemap rail).
 *
 * Spec: docs/specs/accounts-categories-v1.md.
 *
 * Layout:
 *   ┌───────────────┬───────────────────────────┐
 *   │ Top bar       │                           │
 *   ├───────────────┼───────────────────────────┤
 *   │ TREEMAP       │                           │
 *   │ (320px)       │   Right pane (detail)     │
 *   ├───────────────┤                           │
 *   │ OUTLINE       │                           │
 *   │ buckets +     │                           │
 *   │ accounts      │                           │
 *   │ (drag handle) │                           │
 *   └───────────────┴───────────────────────────┘
 *
 * Drag scope (V1): reorder accounts within their current bucket.
 * Reparenting (move to another category) is done via the right-pane
 * category dropdown, not drag — keeps the dnd surface simple and the
 * affordance unambiguous.
 */
import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  AccountBucket,
  AccountBucketCreate,
  AccountBucketUpdate,
  AccountKind,
  AccountListResponse,
  AccountOwner,
  AccountPlacementUpdate,
  AccountRow,
  AccountTagsUpdate,
  ManualAccountKind,
  ManualAccountUpdate,
  YnabRefreshResponse,
} from "@/types/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingBox } from "@/components/LoadingScreen";
import { cn } from "@/lib/utils";

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

const BUCKET_COLORS: { value: string; tw: string; hex: string }[] = [
  { value: "amber", tw: "bg-amber-500", hex: "#fab387" },
  { value: "emerald", tw: "bg-emerald-500", hex: "#a6e3a1" },
  { value: "sky", tw: "bg-sky-500", hex: "#74c7ec" },
  { value: "mauve", tw: "bg-purple-500", hex: "#cba6f7" },
  { value: "pink", tw: "bg-pink-500", hex: "#f5c2e7" },
  { value: "red", tw: "bg-rose-500", hex: "#f38ba8" },
  { value: "teal", tw: "bg-teal-500", hex: "#94e2d5" },
];
const UNCATEGORIZED_COLOR = "#7f849c";

function colorFor(color: string | null | undefined): string {
  return (
    BUCKET_COLORS.find((c) => c.value === color)?.hex || UNCATEGORIZED_COLOR
  );
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

function fmtCAD(v: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(v);
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
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function unwrapId(rowId: string): string {
  const colon = rowId.indexOf(":");
  return colon === -1 ? rowId : rowId.slice(colon + 1);
}

function extractError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Unknown error";
}

// ---------------------------------------------------------------------------
// Treemap — squarified layout
// ---------------------------------------------------------------------------

type TreemapRect = { x: number; y: number; w: number; h: number };
type TreemapInput = { id: string; value: number };

/** Squarified treemap. Splits the rectangle into rows/columns that
 *  approach square aspect ratios for each cell. ~50 LOC; good enough
 *  for ≤20 categories without pulling in d3-hierarchy. */
function layoutTreemap(
  items: TreemapInput[],
  rect: TreemapRect,
): Map<string, TreemapRect> {
  const out = new Map<string, TreemapRect>();
  const filtered = items.filter((i) => i.value > 0);
  if (filtered.length === 0) return out;
  const sorted = [...filtered].sort((a, b) => b.value - a.value);
  let total = sorted.reduce((s, i) => s + i.value, 0);
  let remaining = sorted;
  let current = { ...rect };

  while (remaining.length > 0) {
    const shortSide = Math.min(current.w, current.h);
    const area = current.w * current.h;
    let bestK = 1;
    let bestAspect = worstAspect(remaining.slice(0, 1), shortSide, total, area);
    for (let k = 2; k <= remaining.length; k++) {
      const next = worstAspect(remaining.slice(0, k), shortSide, total, area);
      if (next < bestAspect) {
        bestK = k;
        bestAspect = next;
      } else {
        break;
      }
    }

    const row = remaining.slice(0, bestK);
    const rowTotal = row.reduce((s, i) => s + i.value, 0);
    const rowAreaFrac = rowTotal / total;
    const rowArea = rowAreaFrac * area;

    if (current.w >= current.h) {
      // Lay out as a column on the left.
      const colW = rowArea / current.h;
      let y = current.y;
      for (const item of row) {
        const h = (item.value / rowTotal) * current.h;
        out.set(item.id, { x: current.x, y, w: colW, h });
        y += h;
      }
      current = {
        x: current.x + colW,
        y: current.y,
        w: current.w - colW,
        h: current.h,
      };
    } else {
      const rowH = rowArea / current.w;
      let x = current.x;
      for (const item of row) {
        const w = (item.value / rowTotal) * current.w;
        out.set(item.id, { x, y: current.y, w, h: rowH });
        x += w;
      }
      current = {
        x: current.x,
        y: current.y + rowH,
        w: current.w,
        h: current.h - rowH,
      };
    }

    total -= rowTotal;
    remaining = remaining.slice(bestK);
  }
  return out;
}

function worstAspect(
  items: TreemapInput[],
  shortSide: number,
  totalRemaining: number,
  area: number,
): number {
  if (items.length === 0) return Infinity;
  const sum = items.reduce((s, i) => s + i.value, 0);
  if (sum === 0) return Infinity;
  const max = Math.max(...items.map((i) => i.value));
  const min = Math.min(...items.map((i) => i.value));
  const w2 = shortSide * shortSide;
  // Classic worst-aspect formula adjusted for partial layout area.
  const s2 = (sum * sum * area) / (totalRemaining * totalRemaining * w2);
  return Math.max(
    (w2 * max * totalRemaining) / (sum * sum * area / totalRemaining * area / area), // simplified guard
    Math.max(
      (max / (sum * sum)) * w2 * sum / totalRemaining,
      (sum * sum * totalRemaining) / (min * w2 * area),
    ),
  );
}

// ---------------------------------------------------------------------------
// Treemap component
// ---------------------------------------------------------------------------

function Treemap({
  buckets,
  bucketTotals,
  uncategorizedTotal,
  selectedBucketId,
  onSelect,
}: {
  buckets: AccountBucket[];
  bucketTotals: Map<string, number>;
  uncategorizedTotal: number;
  selectedBucketId: string | null;
  onSelect: (bucketId: string | null) => void;
}) {
  const W = 296;
  const H = 170;
  const items: TreemapInput[] = useMemo(() => {
    const arr: TreemapInput[] = [];
    for (const b of buckets) {
      const v = bucketTotals.get(b.id) ?? 0;
      if (v > 0) arr.push({ id: b.id, value: v });
    }
    if (uncategorizedTotal > 0) {
      arr.push({ id: "__uncat__", value: uncategorizedTotal });
    }
    return arr;
  }, [buckets, bucketTotals, uncategorizedTotal]);

  const layout = useMemo(
    () => layoutTreemap(items, { x: 0, y: 0, w: W, h: H }),
    [items],
  );

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
        Categorize some accounts to populate the treemap.
      </div>
    );
  }

  const total = items.reduce((s, i) => s + i.value, 0);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      className="block rounded"
      aria-label="Portfolio composition"
    >
      {items.map((item) => {
        const r = layout.get(item.id);
        if (!r) return null;
        const isUncat = item.id === "__uncat__";
        const bucket = isUncat ? null : buckets.find((b) => b.id === item.id);
        const fill = isUncat ? UNCATEGORIZED_COLOR : colorFor(bucket?.color);
        const pct = (item.value / total) * 100;
        const label = isUncat ? "Uncategorized" : bucket?.name || "—";
        const showLabel = r.w >= 60 && r.h >= 28;
        const selected =
          (isUncat && selectedBucketId === "__uncat__") ||
          (!isUncat && selectedBucketId === item.id);
        return (
          <g
            key={item.id}
            onClick={() => onSelect(isUncat ? "__uncat__" : item.id)}
            className="cursor-pointer"
          >
            <rect
              x={r.x}
              y={r.y}
              width={r.w - 1}
              height={r.h - 1}
              fill={fill}
              opacity={selected ? 1 : 0.85}
              rx={2}
              stroke={selected ? "#fff" : "transparent"}
              strokeWidth={selected ? 1.5 : 0}
            />
            {showLabel && (
              <>
                <text
                  x={r.x + 6}
                  y={r.y + 14}
                  fill="#11111b"
                  fontWeight={700}
                  fontSize={11}
                >
                  {label}
                </text>
                <text
                  x={r.x + 6}
                  y={r.y + 26}
                  fill="rgba(17,17,27,.75)"
                  fontWeight={600}
                  fontSize={9}
                >
                  {fmtCAD(item.value)} · {pct.toFixed(0)}%
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Outline — buckets + accounts (drag handles)
// ---------------------------------------------------------------------------

function OutlineRail({
  buckets,
  accountsByBucket,
  uncategorized,
  selection,
  bucketTotals,
  uncategorizedTotal,
  onSelectAccount,
  onSelectBucket,
  onReorderAccounts,
  onCreateBucket,
}: {
  buckets: AccountBucket[];
  accountsByBucket: Map<string, AccountRow[]>;
  uncategorized: AccountRow[];
  selection: Selection;
  bucketTotals: Map<string, number>;
  uncategorizedTotal: number;
  onSelectAccount: (id: string) => void;
  onSelectBucket: (id: string | null) => void;
  onReorderAccounts: (bucketId: string | null, newOrder: AccountRow[]) => void;
  onCreateBucket: (name: string) => void;
}) {
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  return (
    <div className="space-y-1.5 px-2 pb-3">
      <div className="flex items-center justify-between px-2 pb-1 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Categories
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setNewBucketOpen(true)}
        >
          <i className="ti ti-folder-plus mr-1" aria-hidden /> New
        </Button>
      </div>

      {newBucketOpen && (
        <NewBucketInput
          onSubmit={(name) => {
            onCreateBucket(name);
            setNewBucketOpen(false);
          }}
          onCancel={() => setNewBucketOpen(false)}
        />
      )}

      {buckets.map((b) => (
        <BucketSection
          key={b.id}
          bucket={b}
          accounts={accountsByBucket.get(b.id) ?? []}
          total={bucketTotals.get(b.id) ?? 0}
          selection={selection}
          onSelectBucket={() => onSelectBucket(b.id)}
          onSelectAccount={onSelectAccount}
          onReorderAccounts={(next) => onReorderAccounts(b.id, next)}
        />
      ))}

      {uncategorized.length > 0 && (
        <BucketSection
          bucket={null}
          accounts={uncategorized}
          total={uncategorizedTotal}
          selection={selection}
          onSelectBucket={() => onSelectBucket("__uncat__")}
          onSelectAccount={onSelectAccount}
          onReorderAccounts={(next) => onReorderAccounts(null, next)}
        />
      )}
    </div>
  );
}

function NewBucketInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="px-2 py-1">
      <Input
        autoFocus
        placeholder="Category name…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (value.trim()) onSubmit(value.trim());
          else onCancel();
        }}
        className="h-7 text-xs"
      />
    </div>
  );
}

function BucketSection({
  bucket,
  accounts,
  total,
  selection,
  onSelectBucket,
  onSelectAccount,
  onReorderAccounts,
}: {
  bucket: AccountBucket | null;
  accounts: AccountRow[];
  total: number;
  selection: Selection;
  onSelectBucket: () => void;
  onSelectAccount: (id: string) => void;
  onReorderAccounts: (next: AccountRow[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isUncat = bucket === null;
  const color = isUncat ? UNCATEGORIZED_COLOR : colorFor(bucket?.color);
  const name = isUncat ? "Uncategorized" : bucket!.name;
  const bucketSelected =
    (isUncat && selection?.kind === "bucket" && selection.bucketId === "__uncat__") ||
    (!isUncat &&
      selection?.kind === "bucket" &&
      selection.bucketId === bucket!.id);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = accounts.findIndex((a) => a.id === active.id);
    const newIdx = accounts.findIndex((a) => a.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    onReorderAccounts(arrayMove(accounts, oldIdx, newIdx));
  }

  return (
    <div className="rounded-md">
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer",
          bucketSelected ? "bg-primary/10" : "hover:bg-muted/30",
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="text-muted-foreground"
        >
          <i
            className={cn(
              "ti text-xs",
              expanded ? "ti-chevron-down" : "ti-chevron-right",
            )}
            aria-hidden
          />
        </button>
        <span
          className="inline-block h-3 w-1 rounded-sm"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <button
          type="button"
          onClick={onSelectBucket}
          className="flex-1 text-left text-sm font-medium"
        >
          {name}
        </button>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {fmtCAD(total)}
        </span>
      </div>

      {expanded && accounts.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={accounts.map((a) => a.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="ml-6 mt-0.5 space-y-0.5">
              {accounts.map((a) => (
                <OutlineAccount
                  key={a.id}
                  account={a}
                  selected={
                    selection?.kind === "account" && selection.rowId === a.id
                  }
                  onSelect={() => onSelectAccount(a.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function OutlineAccount({
  account,
  selected,
  onSelect,
}: {
  account: AccountRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: account.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const cad = num(account.balance_cad);
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-1 text-[13px]",
        selected ? "bg-primary/15" : "hover:bg-muted/30",
      )}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground touch-none"
        aria-label={`Drag ${account.name}`}
        {...attributes}
        {...listeners}
      >
        <i className="ti ti-grip-vertical text-xs" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 items-center justify-between gap-2 text-left"
      >
        <span className="truncate">{account.name}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {account.balance_cad === null ? "—" : fmtCAD(cad)}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Right pane
// ---------------------------------------------------------------------------

type Selection =
  | { kind: "account"; rowId: string }
  | { kind: "bucket"; bucketId: string }
  | null;

function DetailPane({
  selection,
  accounts,
  buckets,
  onClearSelection,
}: {
  selection: Selection;
  accounts: AccountRow[];
  buckets: AccountBucket[];
  onClearSelection: () => void;
}) {
  if (!selection) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-center text-sm text-muted-foreground">
        <div>
          <i
            className="ti ti-hand-click mb-2 text-3xl"
            style={{ display: "block" }}
            aria-hidden
          />
          Pick an account or category from the rail.
        </div>
      </div>
    );
  }
  if (selection.kind === "account") {
    const row = accounts.find((a) => a.id === selection.rowId);
    if (!row) {
      return (
        <div className="p-6 text-sm text-muted-foreground">
          That account no longer exists.{" "}
          <button className="underline" onClick={onClearSelection}>
            Clear selection
          </button>
        </div>
      );
    }
    return <AccountDetail account={row} buckets={buckets} />;
  }
  // bucket
  if (selection.bucketId === "__uncat__") {
    const inBucket = accounts.filter((a) => a.bucket_id === null);
    return (
      <BucketOverview
        bucket={null}
        accounts={inBucket}
        onClearSelection={onClearSelection}
      />
    );
  }
  const bucket = buckets.find((b) => b.id === selection.bucketId);
  if (!bucket) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        That category no longer exists.{" "}
        <button className="underline" onClick={onClearSelection}>
          Clear selection
        </button>
      </div>
    );
  }
  const inBucket = accounts.filter((a) => a.bucket_id === bucket.id);
  return (
    <BucketOverview
      bucket={bucket}
      accounts={inBucket}
      onClearSelection={onClearSelection}
    />
  );
}

// ---- Account detail ------------------------------------------------------

function AccountDetail({
  account,
  buckets,
}: {
  account: AccountRow;
  buckets: AccountBucket[];
}) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["accounts"] });

  const tagsMutation = useMutation({
    mutationFn: (tags: AccountTagsUpdate) =>
      apiFetch(
        `/accounts/${account.source}/${unwrapId(account.id)}/tags`,
        { method: "PATCH", body: JSON.stringify(tags) },
      ),
    onSuccess: invalidate,
  });

  const placementMutation = useMutation({
    mutationFn: (body: AccountPlacementUpdate) =>
      apiFetch(
        `/accounts/${account.source}/${unwrapId(account.id)}/placement`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: invalidate,
  });

  const manualPatchMutation = useMutation({
    mutationFn: (body: ManualAccountUpdate) =>
      apiFetch(`/accounts/manual/${unwrapId(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/accounts/manual/${unwrapId(account.id)}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });

  const [balanceDraft, setBalanceDraft] = useState<string | null>(null);
  const editing = balanceDraft !== null;
  const cad = num(account.balance_cad);
  const isYnab = account.source === "ynab";

  function commitBalance() {
    if (balanceDraft === null) return;
    const trimmed = balanceDraft.trim();
    if (trimmed && trimmed !== String(account.balance)) {
      manualPatchMutation.mutate({ balance: trimmed });
    }
    setBalanceDraft(null);
  }

  return (
    <div className="p-6">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-lg font-semibold">{account.name}</h3>
        <div className="flex items-center gap-2">
          {isYnab ? (
            <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-300">
              YNAB · Read-only
            </span>
          ) : (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Manual
            </span>
          )}
          {!isYnab && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (confirm(`Delete "${account.name}"?`))
                  deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className="h-7 text-destructive"
            >
              <i className="ti ti-trash" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      <p className="mb-5 text-xs text-muted-foreground">
        {account.bank ? `${account.bank} · ` : ""}
        {isYnab
          ? `Synced ${fmtRelative(account.last_synced_at)}`
          : `Updated ${fmtRelative(account.balance_as_of)}`}
      </p>

      <div className="mb-6 rounded-md border bg-muted/30 p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Balance · CAD
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <div className="text-2xl font-bold tabular-nums">
            {account.balance_cad === null ? "—" : fmtCAD(cad)}
          </div>
          {account.currency !== "CAD" && (
            <div className="text-sm tabular-nums text-muted-foreground">
              {fmtMoney(account.balance, account.currency)}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Native amount
          </Label>
          {!isYnab && editing ? (
            <Input
              autoFocus
              type="number"
              step="0.01"
              value={balanceDraft ?? ""}
              onChange={(e) => setBalanceDraft(e.target.value)}
              onBlur={commitBalance}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBalance();
                if (e.key === "Escape") setBalanceDraft(null);
              }}
              className="mt-1"
            />
          ) : (
            <button
              type="button"
              disabled={isYnab}
              onClick={() => setBalanceDraft(String(account.balance))}
              className={cn(
                "mt-1 flex w-full items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm tabular-nums",
                !isYnab && "hover:border-primary",
              )}
            >
              <span>{fmtMoney(account.balance, account.currency)}</span>
              {!isYnab && (
                <i className="ti ti-pencil text-xs text-primary/70" aria-hidden />
              )}
            </button>
          )}
        </div>

        <SelectField
          label="Category"
          value={account.bucket_id ?? "__none__"}
          options={[
            { value: "__none__", label: "Uncategorized" },
            ...buckets.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(v) =>
            placementMutation.mutate({
              bucket_id: v === "__none__" ? null : v,
              sort_index: account.sort_index,
            })
          }
        />

        <SelectField
          label="Kind"
          value={account.kind}
          options={KIND_OPTIONS}
          onChange={(v) => tagsMutation.mutate({ kind: v as AccountKind })}
          disabled={isYnab && false}
        />

        <SelectField
          label="Owner"
          value={account.owner}
          options={OWNER_OPTIONS}
          onChange={(v) => tagsMutation.mutate({ owner: v as AccountOwner })}
        />

        {!isYnab && (
          <ManualBankField
            account={account}
            onSave={(bank) => manualPatchMutation.mutate({ bank })}
          />
        )}

        <SourceField account={account} />
      </div>

      {tagsMutation.isError && (
        <p className="mt-4 text-xs text-destructive">
          Save failed: {extractError(tagsMutation.error)}
        </p>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "mt-1 block w-full rounded-md border bg-card px-3 py-2 text-sm",
          "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          disabled && "opacity-60",
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ManualBankField({
  account,
  onSave,
}: {
  account: AccountRow;
  onSave: (bank: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Bank
      </Label>
      {editing ? (
        <Input
          autoFocus
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const v = (draft ?? "").trim();
            if (v !== (account.bank ?? "")) onSave(v || null);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(null);
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="mt-1"
        />
      ) : (
        <button
          type="button"
          onClick={() => setDraft(account.bank ?? "")}
          className="mt-1 flex w-full items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm hover:border-primary"
        >
          <span className={account.bank ? "" : "text-muted-foreground"}>
            {account.bank || "—"}
          </span>
          <i className="ti ti-pencil text-xs text-primary/70" aria-hidden />
        </button>
      )}
    </div>
  );
}

function SourceField({ account }: { account: AccountRow }) {
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Source
      </Label>
      <div className="mt-1 flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <span>{account.source === "ynab" ? "YNAB" : "Manual"}</span>
        <span className="text-xs">{account.currency}</span>
      </div>
    </div>
  );
}

// ---- Bucket overview ----------------------------------------------------

function BucketOverview({
  bucket,
  accounts,
  onClearSelection,
}: {
  bucket: AccountBucket | null;
  accounts: AccountRow[];
  onClearSelection: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["accounts"] });
  const isUncat = bucket === null;

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const renameMutation = useMutation({
    mutationFn: (body: AccountBucketUpdate) =>
      apiFetch<AccountBucket>(`/accounts/buckets/${bucket!.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/accounts/buckets/${bucket!.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidate();
      onClearSelection();
    },
  });

  const total = accounts.reduce((s, a) => s + num(a.balance_cad), 0);

  return (
    <div className="p-6">
      <div className="mb-5 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-4 w-1 rounded-sm"
            style={{ backgroundColor: isUncat ? UNCATEGORIZED_COLOR : colorFor(bucket?.color) }}
            aria-hidden
          />
          {!isUncat && nameDraft !== null ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const v = nameDraft.trim();
                if (v && v !== bucket!.name) renameMutation.mutate({ name: v });
                setNameDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNameDraft(null);
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="h-8 max-w-xs"
            />
          ) : (
            <h3
              className={cn(
                "text-lg font-semibold",
                !isUncat && "cursor-pointer hover:underline",
              )}
              onClick={() => {
                if (!isUncat) setNameDraft(bucket!.name);
              }}
            >
              {isUncat ? "Uncategorized" : bucket!.name}
            </h3>
          )}
        </div>
        {!isUncat && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-destructive"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (
                confirm(
                  `Delete "${bucket!.name}"? Accounts move to Uncategorized.`,
                )
              )
                deleteMutation.mutate();
            }}
          >
            <i className="ti ti-trash mr-1" aria-hidden /> Delete category
          </Button>
        )}
      </div>

      <div className="mb-6 rounded-md border bg-muted/30 p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Total · CAD
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums">
          {fmtCAD(total)}
        </div>
        <div className="text-xs text-muted-foreground">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
        </div>
      </div>

      {!isUncat && (
        <ColorPicker
          current={bucket?.color ?? null}
          onPick={(c) => renameMutation.mutate({ color: c })}
        />
      )}

      <div className="mt-6">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          Accounts
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts yet.</p>
        ) : (
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
              >
                <span>{a.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {a.balance_cad === null ? "—" : fmtCAD(num(a.balance_cad))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ColorPicker({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (color: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Color
      </div>
      <div className="flex flex-wrap gap-1.5">
        {BUCKET_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onPick(c.value)}
            aria-label={`Set color to ${c.value}`}
            className={cn(
              "h-6 w-6 rounded border-2",
              current === c.value
                ? "border-foreground"
                : "border-transparent hover:border-muted-foreground",
            )}
            style={{ backgroundColor: c.hex }}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Accounts() {
  const qc = useQueryClient();
  const accountsQ = useQuery<AccountListResponse>({
    queryKey: ["accounts"],
    queryFn: () => apiFetch<AccountListResponse>("/accounts"),
  });

  const syncMutation = useMutation<YnabRefreshResponse, ApiError, void>({
    mutationFn: () =>
      apiFetch<YnabRefreshResponse>("/accounts/ynab/sync", {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const createBucketMutation = useMutation({
    mutationFn: (body: AccountBucketCreate) =>
      apiFetch<AccountBucket>("/accounts/buckets", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const placementMutation = useMutation({
    mutationFn: (vars: {
      source: string;
      id: string;
      body: AccountPlacementUpdate;
    }) =>
      apiFetch(`/accounts/${vars.source}/${vars.id}/placement`, {
        method: "PATCH",
        body: JSON.stringify(vars.body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const [selection, setSelection] = useState<Selection>(null);

  const data = accountsQ.data;
  const accounts = data?.accounts ?? [];
  const buckets = useMemo(
    () => (data?.buckets ?? []).slice().sort((a, b) => a.sort_order - b.sort_order),
    [data],
  );

  // Group + sort accounts by (bucket, sort_index).
  const { accountsByBucket, uncategorized, bucketTotals, uncategorizedTotal } =
    useMemo(() => {
      const byBucket = new Map<string, AccountRow[]>();
      const uncat: AccountRow[] = [];
      for (const a of accounts) {
        if (a.bucket_id) {
          const list = byBucket.get(a.bucket_id) ?? [];
          list.push(a);
          byBucket.set(a.bucket_id, list);
        } else {
          uncat.push(a);
        }
      }
      for (const [k, list] of byBucket) {
        list.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
        byBucket.set(k, list);
      }
      uncat.sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name));
      const totals = new Map<string, number>();
      for (const [bid, list] of byBucket) {
        totals.set(
          bid,
          list.reduce((s, a) => s + num(a.balance_cad), 0),
        );
      }
      const uncatTotal = uncat.reduce((s, a) => s + num(a.balance_cad), 0);
      return {
        accountsByBucket: byBucket,
        uncategorized: uncat,
        bucketTotals: totals,
        uncategorizedTotal: uncatTotal,
      };
    }, [accounts]);

  const netWorth = useMemo(
    () => accounts.reduce((s, a) => s + num(a.balance_cad), 0),
    [accounts],
  );

  const lastSync = useMemo(() => {
    const stamps = accounts
      .filter((a) => a.source === "ynab" && a.last_synced_at)
      .map((a) => a.last_synced_at!);
    return stamps.length ? stamps.sort().slice(-1)[0] : null;
  }, [accounts]);

  function handleReorder(bucketId: string | null, newOrder: AccountRow[]) {
    // Issue one PATCH per row whose index changed. Optimistic: the
    // invalidate at the end of each mutation will re-fetch and re-render.
    for (let i = 0; i < newOrder.length; i++) {
      const a = newOrder[i];
      if (a.sort_index !== i) {
        placementMutation.mutate({
          source: a.source,
          id: unwrapId(a.id),
          body: { bucket_id: bucketId, sort_index: i },
        });
      }
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      {/* Top bar */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Accounts</h2>
          <p className="text-xs text-muted-foreground">
            Net worth ·{" "}
            <span className="font-medium text-foreground tabular-nums">
              {fmtCAD(netWorth)}
            </span>{" "}
            · YNAB synced {fmtRelative(lastSync)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <i className="ti ti-refresh mr-1" aria-hidden />
            {syncMutation.isPending ? "Syncing…" : "Sync YNAB"}
          </Button>
          <Button asChild type="button" variant="outline" size="sm">
            <Link to="/investments/accounts">
              <i className="ti ti-plus mr-1" aria-hidden /> Brokerage
            </Link>
          </Button>
          <Button asChild type="button" size="sm">
            <Link to="/accounts/manual/new">
              <i className="ti ti-plus mr-1" aria-hidden /> Cash account
            </Link>
          </Button>
        </div>
      </header>

      {accountsQ.isLoading && <LoadingBox />}
      {accountsQ.isError && (
        <p className="text-sm text-destructive">
          Failed to load: {extractError(accountsQ.error)}
        </p>
      )}

      {data && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div
              className="grid"
              style={{ gridTemplateColumns: "320px 1fr", minHeight: "70vh" }}
            >
              <aside className="border-r">
                <div className="p-3">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Portfolio map
                  </div>
                  <Treemap
                    buckets={buckets}
                    bucketTotals={bucketTotals}
                    uncategorizedTotal={uncategorizedTotal}
                    selectedBucketId={
                      selection?.kind === "bucket" ? selection.bucketId : null
                    }
                    onSelect={(id) => {
                      if (id === null) setSelection(null);
                      else setSelection({ kind: "bucket", bucketId: id });
                    }}
                  />
                </div>
                <OutlineRail
                  buckets={buckets}
                  accountsByBucket={accountsByBucket}
                  uncategorized={uncategorized}
                  selection={selection}
                  bucketTotals={bucketTotals}
                  uncategorizedTotal={uncategorizedTotal}
                  onSelectAccount={(id) =>
                    setSelection({ kind: "account", rowId: id })
                  }
                  onSelectBucket={(id) =>
                    setSelection(
                      id === null ? null : { kind: "bucket", bucketId: id },
                    )
                  }
                  onReorderAccounts={handleReorder}
                  onCreateBucket={(name) =>
                    createBucketMutation.mutate({ name })
                  }
                />
              </aside>

              <section className="min-h-[70vh]">
                <DetailPane
                  selection={selection}
                  accounts={accounts}
                  buckets={buckets}
                  onClearSelection={() => setSelection(null)}
                />
              </section>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
