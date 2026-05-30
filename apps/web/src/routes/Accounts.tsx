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
import { useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
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
  AccountBalancePoint,
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

/** Squarified treemap (Bruls/Huijing/van Wijk).
 *
 *  Each iteration: pick a row of items along the short side of the
 *  remaining rectangle; greedily grow the row while it keeps the
 *  worst per-item aspect ratio improving; lay it out as a strip and
 *  recurse on the rest. Produces near-square rectangles regardless of
 *  the value distribution.
 *
 *  Reference: github.com/d3/d3-hierarchy/blob/main/src/treemap/squarify.js
 *  — same algorithm, hand-rolled here so we don't pull a 7KB dep.
 */
function layoutTreemap(
  items: TreemapInput[],
  rect: TreemapRect,
): Map<string, TreemapRect> {
  const out = new Map<string, TreemapRect>();
  const sorted = items
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return out;
  if (sorted.length === 1) {
    out.set(sorted[0].id, { ...rect });
    return out;
  }

  const totalValue = sorted.reduce((s, i) => s + i.value, 0);
  const scale = (rect.w * rect.h) / totalValue;

  let current = { ...rect };
  let i = 0;
  while (i < sorted.length) {
    const shortSide = Math.min(current.w, current.h);
    // Greedily grow the row.
    let rowEnd = i + 1;
    let bestWorst = worst(sorted.slice(i, rowEnd), shortSide, scale);
    while (rowEnd < sorted.length) {
      const next = worst(sorted.slice(i, rowEnd + 1), shortSide, scale);
      if (next > bestWorst) break;
      bestWorst = next;
      rowEnd++;
    }

    const row = sorted.slice(i, rowEnd);
    const rowSum = row.reduce((s, it) => s + it.value, 0);
    const rowArea = rowSum * scale;
    const strip = rowArea / shortSide;

    if (current.w >= current.h) {
      // Strip is a column on the left; full current.h tall, `strip` wide.
      let y = current.y;
      for (const item of row) {
        const h = (item.value / rowSum) * current.h;
        out.set(item.id, { x: current.x, y, w: strip, h });
        y += h;
      }
      current = {
        x: current.x + strip,
        y: current.y,
        w: current.w - strip,
        h: current.h,
      };
    } else {
      // Strip is a row on top; full current.w wide, `strip` tall.
      let x = current.x;
      for (const item of row) {
        const w = (item.value / rowSum) * current.w;
        out.set(item.id, { x, y: current.y, w, h: strip });
        x += w;
      }
      current = {
        x: current.x,
        y: current.y + strip,
        w: current.w,
        h: current.h - strip,
      };
    }
    i = rowEnd;
  }
  return out;
}

/** Standard squarified worst-aspect-ratio for a candidate row.
 *  Given values v_i with sum s, short side w, area-per-unit-value k:
 *  each item's rect is (s·k/w) × (v_i·w/s) inside its strip, so the
 *  per-item aspect is max(t/l, l/t) where t=s·k/w (the strip thickness)
 *  and l=v·w/s (the length along the short side).
 *
 *  The worst case across the row reduces to:
 *      max( max·w² / (s²·k),   s²·k / (min·w²) )
 *  — first term peaks on the largest value, second on the smallest.
 */
function worst(
  row: TreemapInput[],
  shortSide: number,
  scale: number,
): number {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((s, it) => s + it.value, 0);
  if (sum === 0) return Infinity;
  const max = Math.max(...row.map((it) => it.value));
  const min = Math.min(...row.map((it) => it.value));
  const w2 = shortSide * shortSide;
  const s2 = sum * sum;
  return Math.max((max * w2) / (s2 * scale), (s2 * scale) / (min * w2));
}

// ---------------------------------------------------------------------------
// Treemap component
// ---------------------------------------------------------------------------

function Treemap({
  buckets,
  bucketTotals,
  uncategorizedTotal,
  accounts,
  selectedBucketId,
  selectedAccountId,
  onSelectBucket,
  onSelectAccount,
}: {
  buckets: AccountBucket[];
  bucketTotals: Map<string, number>;
  uncategorizedTotal: number;
  accounts: AccountRow[];
  selectedBucketId: string | null;
  selectedAccountId: string | null;
  onSelectBucket: (bucketId: string | null) => void;
  onSelectAccount: (rowId: string) => void;
}) {
  const W = 296;
  const H = 170;

  // Two modes:
  //  - "buckets": at least one bucket exists; map by category (and a
  //    single rect for Uncategorized when non-empty).
  //  - "accounts": fresh user with no categories yet; map by account
  //    so the map is informative immediately ("RBC checking is 30% of
  //    my net worth").
  const mode: "buckets" | "accounts" = buckets.length > 0 ? "buckets" : "accounts";

  // Treemap sizes by absolute exposure ("where is money concentrated"),
  // not net — otherwise a category dominated by credit-card debt
  // would silently disappear. The label still shows the signed value
  // so a liability-heavy bucket is obvious.
  const items: TreemapInput[] = useMemo(() => {
    if (mode === "buckets") {
      const arr: TreemapInput[] = [];
      for (const b of buckets) {
        const v = bucketTotals.get(b.id) ?? 0;
        if (v !== 0) arr.push({ id: b.id, value: Math.abs(v) });
      }
      if (uncategorizedTotal !== 0) {
        arr.push({ id: "__uncat__", value: Math.abs(uncategorizedTotal) });
      }
      return arr;
    }
    return accounts
      .filter((a) => num(a.balance_cad) !== 0)
      .map((a) => ({ id: a.id, value: Math.abs(num(a.balance_cad)) }));
  }, [mode, buckets, bucketTotals, uncategorizedTotal, accounts]);

  // Lookup tables for label + signed value per rect.
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    if (mode === "buckets") {
      for (const b of buckets) m.set(b.id, b.name);
      m.set("__uncat__", "Uncategorized");
    } else {
      for (const a of accounts) m.set(a.id, a.name);
    }
    return m;
  }, [mode, buckets, accounts]);

  const signedValueById = useMemo(() => {
    const m = new Map<string, number>();
    if (mode === "buckets") {
      for (const b of buckets) m.set(b.id, bucketTotals.get(b.id) ?? 0);
      m.set("__uncat__", uncategorizedTotal);
    } else {
      for (const a of accounts) m.set(a.id, num(a.balance_cad));
    }
    return m;
  }, [mode, buckets, bucketTotals, uncategorizedTotal, accounts]);

  const fillById = useMemo(() => {
    const m = new Map<string, string>();
    if (mode === "buckets") {
      for (const b of buckets) m.set(b.id, colorFor(b.color));
      m.set("__uncat__", UNCATEGORIZED_COLOR);
    } else {
      // Per-account fallback: cycle the palette by index so adjacent
      // rectangles get distinguishable hues.
      const sorted = [...accounts].sort(
        (a, b) => Math.abs(num(b.balance_cad)) - Math.abs(num(a.balance_cad)),
      );
      sorted.forEach((a, i) => {
        m.set(a.id, BUCKET_COLORS[i % BUCKET_COLORS.length].hex);
      });
    }
    return m;
  }, [mode, buckets, accounts]);

  const layout = useMemo(
    () => layoutTreemap(items, { x: 0, y: 0, w: W, h: H }),
    [items],
  );

  if (items.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="block rounded bg-muted/20"
        aria-label="Portfolio composition (empty)"
      />
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
        const fill = fillById.get(item.id) || UNCATEGORIZED_COLOR;
        const pct = (item.value / total) * 100;
        const label = labelById.get(item.id) || "—";
        const signedValue = signedValueById.get(item.id) ?? 0;
        const showLabel = r.w >= 60 && r.h >= 28;
        const showSub = r.w >= 70 && r.h >= 40;
        const selected =
          mode === "buckets"
            ? (item.id === "__uncat__" && selectedBucketId === "__uncat__") ||
              (item.id !== "__uncat__" && selectedBucketId === item.id)
            : selectedAccountId === item.id;
        const handleClick = () => {
          if (mode === "buckets") {
            onSelectBucket(item.id === "__uncat__" ? "__uncat__" : item.id);
          } else {
            onSelectAccount(item.id);
          }
        };
        return (
          <g
            key={item.id}
            onClick={handleClick}
            className="cursor-pointer"
          >
            <rect
              x={r.x}
              y={r.y}
              width={Math.max(0, r.w - 1)}
              height={Math.max(0, r.h - 1)}
              fill={fill}
              opacity={selected ? 1 : 0.85}
              rx={2}
              stroke={selected ? "#fff" : "transparent"}
              strokeWidth={selected ? 1.5 : 0}
            />
            {showLabel && (
              <text
                x={r.x + 6}
                y={r.y + 14}
                fill="#11111b"
                fontWeight={700}
                fontSize={11}
              >
                {label.length > Math.floor(r.w / 7)
                  ? `${label.slice(0, Math.floor(r.w / 7) - 1)}…`
                  : label}
              </text>
            )}
            {showSub && (
              <text
                x={r.x + 6}
                y={r.y + 26}
                fill="rgba(17,17,27,.75)"
                fontWeight={600}
                fontSize={9}
              >
                {fmtCAD(signedValue)} · {pct.toFixed(0)}%
              </text>
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
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // The rail's drop containers, in render order. The uncategorized bin is
  // always present so an account can be dragged out of a category, even
  // when nothing is uncategorized yet.
  const UNCAT_KEY = "__uncat__";
  const itemsForKey = (key: string): AccountRow[] =>
    key === UNCAT_KEY ? uncategorized : (accountsByBucket.get(key) ?? []);
  const bucketIdForKey = (key: string): string | null =>
    key === UNCAT_KEY ? null : key;
  const containerKeyOf = (accountId: string): string | null => {
    for (const b of buckets) {
      if ((accountsByBucket.get(b.id) ?? []).some((a) => a.id === accountId))
        return b.id;
    }
    if (uncategorized.some((a) => a.id === accountId)) return UNCAT_KEY;
    return null;
  };
  const isContainerKey = (id: string): boolean =>
    id === UNCAT_KEY || buckets.some((b) => b.id === id);

  const activeAccount = activeId
    ? [...accountsByBucket.values()].flat().concat(uncategorized).find(
        (a) => a.id === activeId,
      ) ?? null
    : null;

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const activeKey = containerKeyOf(String(active.id));
    if (activeKey === null) return;
    const overId = String(over.id);
    const overKey = isContainerKey(overId) ? overId : containerKeyOf(overId);
    if (overKey === null) return;

    const fromItems = itemsForKey(activeKey);
    const moved = fromItems.find((a) => a.id === String(active.id));
    if (!moved) return;

    if (activeKey === overKey) {
      // Reorder within the same container.
      const oldIdx = fromItems.findIndex((a) => a.id === String(active.id));
      const overIdx = isContainerKey(overId)
        ? fromItems.length - 1
        : fromItems.findIndex((a) => a.id === overId);
      if (oldIdx === overIdx || overIdx === -1) return;
      onReorderAccounts(
        bucketIdForKey(activeKey),
        arrayMove(fromItems, oldIdx, overIdx),
      );
      return;
    }

    // Move across containers: splice into the target, drop from the source.
    const toItems = itemsForKey(overKey);
    const insertAt = isContainerKey(overId)
      ? toItems.length
      : Math.max(0, toItems.findIndex((a) => a.id === overId));
    const newTo = [...toItems];
    newTo.splice(insertAt, 0, moved);
    onReorderAccounts(bucketIdForKey(overKey), newTo);
    onReorderAccounts(
      bucketIdForKey(activeKey),
      fromItems.filter((a) => a.id !== String(active.id)),
    );
  }

  return (
    <div className="space-y-0.5 px-2 pb-3">
      <div className="flex items-center justify-between px-2 pb-1 pt-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Categories
        </span>
        <button
          type="button"
          onClick={() => setNewBucketOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          <i className="ti ti-folder-plus" aria-hidden /> New
        </button>
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {buckets.map((b) => (
          <BucketSection
            key={b.id}
            containerKey={b.id}
            bucket={b}
            accounts={accountsByBucket.get(b.id) ?? []}
            total={bucketTotals.get(b.id) ?? 0}
            selection={selection}
            isDragging={activeId !== null}
            onSelectBucket={() => onSelectBucket(b.id)}
            onSelectAccount={onSelectAccount}
          />
        ))}

        <BucketSection
          containerKey={UNCAT_KEY}
          bucket={null}
          accounts={uncategorized}
          total={uncategorizedTotal}
          selection={selection}
          isDragging={activeId !== null}
          onSelectBucket={() => onSelectBucket("__uncat__")}
          onSelectAccount={onSelectAccount}
        />

        <DragOverlay>
          {activeAccount ? (
            <div className="flex items-center gap-1.5 rounded border bg-popover px-2 py-1 text-[13px] shadow-md">
              <i
                className="ti ti-grip-vertical text-xs text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{activeAccount.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
  containerKey,
  bucket,
  accounts,
  total,
  selection,
  isDragging,
  onSelectBucket,
  onSelectAccount,
}: {
  /** Drop-container id: a bucket UUID, or "__uncat__" for the uncategorized bin. */
  containerKey: string;
  bucket: AccountBucket | null;
  accounts: AccountRow[];
  total: number;
  selection: Selection;
  /** True while any account is mid-drag — used to reveal empty drop zones. */
  isDragging: boolean;
  onSelectBucket: () => void;
  onSelectAccount: (id: string) => void;
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

  // The whole section is a drop target so an account can be dropped onto
  // the header or an empty body, not just onto a sibling row.
  const { setNodeRef, isOver } = useDroppable({ id: containerKey });

  // Hide an empty uncategorized bin unless something is being dragged (so it
  // doesn't add clutter when every account is already categorised).
  if (isUncat && accounts.length === 0 && !isDragging) return null;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md",
        isOver && "bg-primary/5 ring-1 ring-primary/30",
      )}
    >
      <div
        className={cn(
          "group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer",
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
          className="shrink-0 text-muted-foreground"
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
          className="inline-block h-3.5 shrink-0 rounded-sm"
          style={{ backgroundColor: color, width: "4px" }}
          aria-hidden
        />
        <button
          type="button"
          onClick={onSelectBucket}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium"
        >
          {name}
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {fmtCAD(total)}
        </span>
      </div>

      {expanded && (
        <SortableContext
          items={accounts.map((a) => a.id)}
          strategy={verticalListSortingStrategy}
        >
          {accounts.length > 0 ? (
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
          ) : (
            isDragging && (
              <div className="ml-6 mt-0.5 rounded border border-dashed border-muted-foreground/30 px-2 py-2 text-center text-[11px] text-muted-foreground">
                Drop here
              </div>
            )
          )}
        </SortableContext>
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
        "flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-[13px]",
        selected ? "bg-primary/15" : "hover:bg-muted/30",
      )}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab text-muted-foreground touch-none"
        aria-label={`Drag ${account.name}`}
        {...attributes}
        {...listeners}
      >
        <i className="ti ti-grip-vertical text-xs" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0 truncate">{account.name}</span>
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
  const currentBucket = buckets.find((b) => b.id === account.bucket_id) ?? null;
  const categoryName = currentBucket?.name ?? "Uncategorized";

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
      {/* Header row */}
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
        {account.bank ? `${account.bank} · ` : ""}Category: {categoryName}
      </p>

      {/* Balance + sparkline (3-col: 1fr + 2fr) */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        <div className="col-span-1 rounded-md bg-muted/40 p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Balance · CAD
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {account.balance_cad === null ? "—" : fmtCAD(cad)}
          </div>
          {account.currency !== "CAD" && (
            <div className="text-xs tabular-nums text-muted-foreground">
              {fmtMoney(account.balance, account.currency)}
            </div>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground">
            {isYnab
              ? `Synced ${fmtRelative(account.last_synced_at)}`
              : `Updated ${fmtRelative(account.balance_as_of)}`}
          </div>
        </div>
        <div className="col-span-2 rounded-md bg-muted/40 p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            30-day balance
          </div>
          <Sparkline account={account} />
        </div>
      </div>

      {/* Field grid — Name · Bank · Kind · Owner · Category · Source */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <ReadField label="Name" value={account.name} />

        {!isYnab ? (
          <ManualBankField
            account={account}
            onSave={(bank) => manualPatchMutation.mutate({ bank })}
          />
        ) : (
          <ReadField label="Bank" value={account.bank ?? "—"} />
        )}

        <SelectField
          label="Kind"
          value={account.kind}
          options={KIND_OPTIONS}
          onChange={(v) => tagsMutation.mutate({ kind: v as AccountKind })}
        />

        <SelectField
          label="Owner"
          value={account.owner}
          options={OWNER_OPTIONS}
          onChange={(v) => tagsMutation.mutate({ owner: v as AccountOwner })}
        />

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

        <SourceField account={account} />

        {/* Native amount inline edit (manual only) — full width below */}
        {!isYnab && (
          <div className="col-span-2">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Native amount
            </Label>
            {editing ? (
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
                onClick={() => setBalanceDraft(String(account.balance))}
                className="mt-1 flex w-full items-center justify-between rounded-md border bg-card px-3 py-2 text-left text-sm tabular-nums hover:border-primary"
              >
                <span>{fmtMoney(account.balance, account.currency)}</span>
                <i
                  className="ti ti-pencil text-xs text-primary/70"
                  aria-hidden
                />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 border-t pt-4 text-xs text-muted-foreground">
        {isYnab
          ? `YNAB rows are read-only · last refresh ${fmtRelative(account.last_synced_at)}.`
          : "Manual rows support inline editing on every field above."}
      </div>

      {tagsMutation.isError && (
        <p className="mt-4 text-xs text-destructive">
          Save failed: {extractError(tagsMutation.error)}
        </p>
      )}
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <div className="mt-1 rounded-md border bg-card px-3 py-2 text-sm">
        {value}
      </div>
    </div>
  );
}

/** Real 30-day balance sparkline, fed by per-account daily snapshots
 *  (GET /accounts/{source}/{id}/balance-history). History is captured
 *  forward-only, so a brand-new account shows a flat line at its current
 *  balance until a few days of snapshots accrue — by design. A flat line
 *  is also drawn whenever the balance hasn't moved in the window. */
function Sparkline({ account }: { account: AccountRow }) {
  const source = account.source;
  const rawId = account.id.slice(source.length + 1); // strip "source:" prefix
  const { data } = useQuery<AccountBalancePoint[]>({
    queryKey: ["account-balance-history", account.id],
    queryFn: () =>
      apiFetch<AccountBalancePoint[]>(
        `/accounts/${source}/${rawId}/balance-history?days=30`,
      ),
    staleTime: 60_000,
  });

  const W = 380;
  const H = 60;
  const PAD = 4;

  // Prefer the CAD series so a multi-currency account's line is comparable
  // with the headline balance; fall back to native if FX was unavailable.
  const values = (data ?? []).map((p) =>
    Number(p.cad_amount ?? p.native_amount),
  );
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;

  let points: string;
  if (values.length >= 2 && max !== min) {
    const span = max - min;
    const stepX = (W - PAD * 2) / (values.length - 1);
    points = values
      .map((v, i) => {
        const x = PAD + i * stepX;
        // Invert Y so larger balances sit higher in the box.
        const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  } else {
    // 0/1 point, or no movement → honest flat line at mid-height.
    const y = H / 2;
    points = `${PAD},${y} ${W - PAD},${y}`;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      className="mt-2 block"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
        opacity="0.85"
      />
    </svg>
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
            className="inline-block h-5 rounded-sm"
            style={{
              backgroundColor: isUncat
                ? UNCATEGORIZED_COLOR
                : colorFor(bucket?.color),
              width: "4px",
            }}
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

  // Resizable left rail. Width persists across visits via localStorage and
  // is clamped to a sensible range so the rail can't be dragged away.
  const RAIL_MIN = 240;
  const RAIL_MAX = 640;
  const [railWidth, setRailWidth] = useState<number>(() => {
    const stored = Number(
      typeof window !== "undefined"
        ? window.localStorage.getItem("accounts.railWidth")
        : NaN,
    );
    return Number.isFinite(stored)
      ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, stored))
      : 320;
  });
  const resizeStart = useRef<{ x: number; w: number } | null>(null);

  function onResizeDown(e: React.PointerEvent) {
    resizeStart.current = { x: e.clientX, w: railWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: React.PointerEvent) {
    if (!resizeStart.current) return;
    const next = Math.min(
      RAIL_MAX,
      Math.max(RAIL_MIN, resizeStart.current.w + (e.clientX - resizeStart.current.x)),
    );
    setRailWidth(next);
  }
  function onResizeUp(e: React.PointerEvent) {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Persist the latest width (read via the functional setter to dodge stale closure).
    setRailWidth((w) => {
      window.localStorage.setItem("accounts.railWidth", String(w));
      return w;
    });
  }

  const data = accountsQ.data;
  const accounts = data?.accounts ?? [];

  // First load: auto-select the highest-CAD account so the right pane
  // shows something useful immediately. User can clear at any time.
  if (selection === null && accounts.length > 0) {
    const top = [...accounts].sort(
      (a, b) => num(b.balance_cad) - num(a.balance_cad),
    )[0];
    if (top) {
      // setSelection inside render is allowed when guarded — this only
      // runs on the first render with non-empty data.
      setSelection({ kind: "account", rowId: top.id });
    }
  }
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
    // Issue one PATCH per row whose (bucket, index) changed. A cross-category
    // move can land at the same numeric index, so we compare bucket too.
    // Optimistic: each mutation invalidates ["accounts"] and re-renders.
    for (let i = 0; i < newOrder.length; i++) {
      const a = newOrder[i];
      const curBucket = a.bucket_id ?? null;
      if (a.sort_index !== i || curBucket !== bucketId) {
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
      {accountsQ.isLoading && <LoadingBox />}
      {accountsQ.isError && (
        <p className="text-sm text-destructive">
          Failed to load: {extractError(accountsQ.error)}
        </p>
      )}

      {data && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {/* Top bar — lives inside the card so the whole page reads
             *  as one bordered surface (matches Concept C mockup). */}
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
              <h2 className="text-base font-semibold">Accounts</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                Net worth ·{" "}
                <span className="font-medium text-foreground">
                  {fmtCAD(netWorth)}
                </span>
              </span>
              <div className="flex-1" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="h-7 text-xs"
              >
                <i className="ti ti-refresh mr-1" aria-hidden />
                {syncMutation.isPending
                  ? "Syncing…"
                  : `Sync YNAB · ${fmtRelative(lastSync)}`}
              </Button>
              <Button
                asChild
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Link to="/accounts/manual/new">
                  <i className="ti ti-plus mr-1" aria-hidden /> Cash
                </Link>
              </Button>
              <Button
                asChild
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Link to="/investments/accounts">
                  <i className="ti ti-plus mr-1" aria-hidden /> Brokerage
                </Link>
              </Button>
            </div>

            <div
              className="grid"
              style={{
                gridTemplateColumns: `${railWidth}px 1fr`,
                minHeight: "70vh",
              }}
            >
              <aside className="relative border-r">
                {/* Drag the divider to resize the rail. */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  title="Drag to resize"
                  onPointerDown={onResizeDown}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeUp}
                  className="absolute right-0 top-0 z-10 h-full w-2 -mr-1 cursor-col-resize touch-none transition-colors hover:bg-primary/30"
                />
                <div className="p-3">
                  <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Portfolio map
                  </div>
                  <Treemap
                    buckets={buckets}
                    bucketTotals={bucketTotals}
                    uncategorizedTotal={uncategorizedTotal}
                    accounts={accounts}
                    selectedBucketId={
                      selection?.kind === "bucket" ? selection.bucketId : null
                    }
                    selectedAccountId={
                      selection?.kind === "account" ? selection.rowId : null
                    }
                    onSelectBucket={(id) =>
                      setSelection(
                        id === null ? null : { kind: "bucket", bucketId: id },
                      )
                    }
                    onSelectAccount={(id) =>
                      setSelection({ kind: "account", rowId: id })
                    }
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
