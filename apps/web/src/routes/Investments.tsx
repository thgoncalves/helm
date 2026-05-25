/**
 * Investing Dashboard — compact KPIs, chart, positions, action.
 *
 * Layout, top to bottom:
 *
 *   1. Header — title + "Last snapshot: …" indicator only.
 *   2. Compact KPI strip — single card with total CAD, the split bar,
 *      and the Funds + Stocks sub-stats side by side. Uses less
 *      vertical space than the V1 dual-card layout while keeping the
 *      same numbers (cost basis, unrealised P&L, stale-days).
 *   3. History chart — Total / By source toggle.
 *   4. Positions table — funds (split: manual editable + YNAB read-only)
 *      and the stocks aggregate. "Last synced" column on every row.
 *      Manual rows show a pencil icon on the balance cell to advertise
 *      the click-to-edit affordance.
 *   5. "Snapshot today" button — below the table, where the user goes
 *      after reviewing/updating positions.
 *
 * Snapshot semantics: clicking the button freezes today's positions
 * across all three sources into ``investing_snapshots``. Manual edits
 * land on ``manual_accounts.balance``; the snapshot reads from there.
 *
 * Spec: docs/specs/investing-dashboard-snapshots-v1.md
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  AccountListResponse,
  AccountRow,
  FundsVsStocksResponse,
  InvestingSnapshotDay,
  InvestingSnapshotHistoryItem,
  InvestingSnapshotRow,
  StockPortfolioRow,
} from "@/types/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingBox } from "@/components/LoadingScreen";
import { cn } from "@/lib/utils";

const CHART_PALETTE = [
  "hsl(217 91% 60%)",
  "hsl(158 64% 45%)",
  "hsl(38 92% 50%)",
  "hsl(267 84% 65%)",
  "hsl(0 84% 60%)",
  "hsl(186 65% 45%)",
  "hsl(15 80% 55%)",
  "hsl(280 60% 55%)",
  "hsl(95 55% 45%)",
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

const cadFmt0 = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

function fmtCAD(v: number | string | null): string {
  return cadFmt0.format(num(v));
}

function fmtCADPrecise(v: number | string | null): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num(v));
}

function fmtNative(v: number | string | null, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(num(v));
}

function fmtPct(v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function compactCAD(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/** Relative time for sync indicators — "now", "12m ago", "3d ago", or
 *  the absolute date when older than a week. Accepts ISO timestamp
 *  (YNAB) or ISO date (manual balance_as_of). */
function fmtSyncTime(value: string | null): string {
  if (!value) return "—";
  const t = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  const diffMs = Date.now() - t.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 0) return "today";
  if (diffD === 1) return "yesterday";
  if (diffD < 7) return `${diffD}d ago`;
  return t.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Investments() {
  const qc = useQueryClient();

  const comparisonQ = useQuery<FundsVsStocksResponse>({
    queryKey: ["funds-vs-stocks"],
    queryFn: () =>
      apiFetch<FundsVsStocksResponse>("/investments/stocks/comparison"),
  });

  const accountsQ = useQuery<AccountListResponse>({
    queryKey: ["accounts-all"],
    queryFn: () => apiFetch<AccountListResponse>("/accounts"),
  });

  const historyQ = useQuery<InvestingSnapshotHistoryItem[]>({
    queryKey: ["investing-snapshots-history"],
    queryFn: () =>
      apiFetch<InvestingSnapshotHistoryItem[]>("/investments/snapshots/history"),
  });

  const positionsQ = useQuery<StockPortfolioRow[]>({
    queryKey: ["stock-positions"],
    queryFn: () =>
      apiFetch<StockPortfolioRow[]>("/investments/stocks/positions"),
  });

  const snapshotMutation = useMutation({
    mutationFn: () =>
      apiFetch<InvestingSnapshotDay>("/investments/snapshots", {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investing-snapshots-history"] });
    },
  });

  const fundAccounts = useMemo(
    () =>
      (accountsQ.data?.accounts ?? [])
        .filter((a) => a.kind === "investing_fund" && a.is_active)
        .sort((a, b) => {
          if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [accountsQ.data],
  );

  const stocksCad = num(comparisonQ.data?.stocks.current_value_cad);
  const lastSnapshot =
    historyQ.data && historyQ.data.length > 0
      ? historyQ.data[historyQ.data.length - 1]
      : null;

  const isLoading =
    comparisonQ.isLoading ||
    accountsQ.isLoading ||
    historyQ.isLoading ||
    positionsQ.isLoading;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      {/* Header — title + last snapshot indicator. Action button moved
       *   to the bottom of the page, next to the positions table. */}
      <header>
        <h2 className="text-2xl font-bold">Investing Dashboard</h2>
        <p className="text-sm text-muted-foreground">
          {lastSnapshot
            ? `Last snapshot: ${fmtDate(lastSnapshot.snapshot_date)}`
            : "No snapshots yet — take your first one to start tracking."}
        </p>
      </header>

      {snapshotMutation.isError && (
        <p className="text-sm text-destructive">
          Snapshot failed:{" "}
          {snapshotMutation.error instanceof ApiError
            ? snapshotMutation.error.message
            : "Unknown error"}
        </p>
      )}
      {snapshotMutation.isSuccess && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          Snapshot saved · total {fmtCAD(snapshotMutation.data.total_cad)}
        </p>
      )}

      {isLoading && <LoadingBox />}

      {!isLoading && comparisonQ.data && (
        <KpiStrip data={comparisonQ.data} />
      )}

      {!isLoading && <HistoryCard history={historyQ.data ?? []} />}

      {!isLoading && (
        <PositionsCard
          funds={fundAccounts}
          stocksCad={stocksCad}
          stocksAsOf={null}
          stockPositions={positionsQ.data ?? []}
          onSnapshot={() => snapshotMutation.mutate()}
          snapshotPending={snapshotMutation.isPending}
          snapshotDisabled={fundAccounts.length === 0 && stocksCad === 0}
        />
      )}

      {!isLoading && (historyQ.data?.length ?? 0) > 0 && (
        <SnapshotsCard history={historyQ.data ?? []} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact KPI strip — single card, full width
// ---------------------------------------------------------------------------

function KpiStrip({ data }: { data: FundsVsStocksResponse }) {
  const fundsPct = num(data.funds_pct);
  const stocksPct = num(data.stocks_pct);
  const total = num(data.total_cad);

  if (total === 0) return null;

  const unreal = data.stocks.unrealized_cad;
  const unrealNum = num(unreal);
  const unrealPctNum = num(data.stocks.unrealized_pct);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {/* Row 1 — total */}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Portfolio
          </h3>
          <span className="text-2xl font-bold tabular-nums">
            {fmtCAD(total)}
          </span>
        </div>

        {/* Row 2 — split bar */}
        <div
          className="flex h-2.5 w-full overflow-hidden rounded bg-muted"
          role="img"
          aria-label={`${fundsPct.toFixed(0)}% funds, ${stocksPct.toFixed(0)}% stocks`}
        >
          {fundsPct > 0 && (
            <div
              className="bg-sky-500"
              style={{ width: `${fundsPct}%` }}
            />
          )}
          {stocksPct > 0 && (
            <div
              className="bg-emerald-500"
              style={{ width: `${stocksPct}%` }}
            />
          )}
        </div>

        {/* Row 3 — side-by-side sub-stats */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="border-l-2 border-sky-500 pl-3">
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Funds · {fundsPct.toFixed(0)}%</span>
              <span>
                {data.funds.accounts_count} accts
                {data.funds.stale_days !== null && (
                  <>
                    {" · "}
                    <span
                      className={cn(
                        data.funds.stale_days > 30
                          ? "text-amber-600 dark:text-amber-400"
                          : "",
                      )}
                    >
                      {data.funds.stale_days === 0
                        ? "fresh today"
                        : `oldest ${data.funds.stale_days}d`}
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="text-base font-semibold tabular-nums">
              {fmtCAD(data.funds.current_value_cad)}
            </div>
          </div>

          <div className="border-l-2 border-emerald-500 pl-3">
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Stocks · {stocksPct.toFixed(0)}%</span>
              <span>
                {data.stocks.holdings_count} holdings
                {data.stocks.cost_basis_cad !== null && (
                  <> · cost {fmtCAD(data.stocks.cost_basis_cad)}</>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-base font-semibold tabular-nums">
                {fmtCAD(data.stocks.current_value_cad)}
              </span>
              {unreal !== null && (
                <span
                  className={cn(
                    "text-xs font-medium tabular-nums",
                    unrealNum > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : unrealNum < 0
                        ? "text-red-600 dark:text-red-400"
                        : "",
                  )}
                >
                  {unrealNum > 0 ? "+" : ""}
                  {fmtCADPrecise(unreal)} ({fmtPct(unrealPctNum)})
                </span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// History chart
// ---------------------------------------------------------------------------

type ChartView = "total" | "stacked";
type ChartScale = "cad" | "pct";

/** Percent-change suffix appended to each source/total key when scale=pct
 *  (e.g. ``"Stocks"`` → ``"Stocks__pct"``). Prefixing two underscores keeps
 *  the suffix unique even if a real account is ever named "pct". */
const PCT_SUFFIX = "__pct";

function pctKey(label: string): string {
  return `${label}${PCT_SUFFIX}`;
}

function HistoryCard({
  history,
}: {
  history: InvestingSnapshotHistoryItem[];
}) {
  const [view, setView] = useState<ChartView>("total");
  const [scale, setScale] = useState<ChartScale>("cad");

  const sourceLabels = useMemo(() => {
    const set = new Set<string>();
    for (const item of history) {
      for (const k of Object.keys(item.by_source)) set.add(k);
    }
    return Array.from(set).sort();
  }, [history]);

  // Bases for percent-change rebasing — first non-zero value per series,
  // remembered with the index where it first appeared so we can leave
  // earlier rows blank (a source that started later shouldn't plot at
  // -100% for the period it didn't exist).
  const bases = useMemo(() => {
    const out: {
      total: { value: number; startIndex: number } | null;
      bySource: Record<string, { value: number; startIndex: number } | null>;
    } = {
      total: null,
      bySource: {},
    };
    for (let i = 0; i < history.length; i++) {
      const t = num(history[i].total_cad);
      if (t !== 0) {
        out.total = { value: t, startIndex: i };
        break;
      }
    }
    for (const label of sourceLabels) {
      out.bySource[label] = null;
      for (let i = 0; i < history.length; i++) {
        const v = num(history[i].by_source[label] ?? 0);
        if (v !== 0) {
          out.bySource[label] = { value: v, startIndex: i };
          break;
        }
      }
    }
    return out;
  }, [history, sourceLabels]);

  const data = useMemo(
    () =>
      history.map((item, idx) => {
        // ``null`` over ``undefined`` so recharts treats it as a real
        // gap (skip the dot) rather than dropping the field entirely.
        const row: Record<string, number | string | null> = {
          date: item.snapshot_date,
          total: num(item.total_cad),
        };
        for (const label of sourceLabels) {
          row[label] = num(item.by_source[label] ?? 0);
        }
        // Percent-change keys — independent of the CAD keys so the
        // chart can swap series without re-shaping data on every toggle.
        if (bases.total !== null) {
          row[pctKey("total")] =
            idx < bases.total.startIndex
              ? null
              : (num(item.total_cad) / bases.total.value - 1) * 100;
        }
        for (const label of sourceLabels) {
          const base = bases.bySource[label];
          if (base !== null) {
            row[pctKey(label)] =
              idx < base.startIndex
                ? null
                : (num(item.by_source[label] ?? 0) / base.value - 1) * 100;
          }
        }
        return row;
      }),
    [history, sourceLabels, bases],
  );

  // Series that survive rebasing — used for both the stacked-pct lines
  // and the legend (so a zero-history source doesn't get an orphaned chip).
  const pctSourceLabels = useMemo(
    () => sourceLabels.filter((l) => bases.bySource[l] !== null),
    [sourceLabels, bases],
  );

  if (history.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Take your first snapshot to start tracking progress over time.
        </CardContent>
      </Card>
    );
  }

  const isPct = scale === "pct";
  // Y-axis + tooltip number formatting — branches once on scale.
  const yTick = (v: number | string) =>
    isPct ? `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(0)}%` : compactCAD(Number(v));
  const tooltipFmt = (v: number | string) =>
    isPct
      ? `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`
      : fmtCAD(Number(v));

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            History
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {/* View — what to chart */}
            <div
              role="tablist"
              aria-label="Chart view"
              className="flex overflow-hidden rounded-md border text-xs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={view === "total"}
                onClick={() => setView("total")}
                className={cn(
                  "px-2.5 py-1",
                  view === "total"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                Total
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "stacked"}
                onClick={() => setView("stacked")}
                className={cn(
                  "border-l px-2.5 py-1",
                  view === "stacked"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                By source
              </button>
            </div>

            {/* Scale — amount vs. percent change */}
            <div
              role="tablist"
              aria-label="Chart scale"
              className="flex overflow-hidden rounded-md border text-xs"
            >
              <button
                type="button"
                role="tab"
                aria-selected={scale === "cad"}
                onClick={() => setScale("cad")}
                className={cn(
                  "px-2.5 py-1",
                  scale === "cad"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                title="Show CAD amounts"
              >
                $
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scale === "pct"}
                onClick={() => setScale("pct")}
                className={cn(
                  "border-l px-2.5 py-1",
                  scale === "pct"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                title="Show balance change vs. first snapshot"
              >
                %
              </button>
            </div>
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {view === "stacked" && scale === "cad" ? (
              <AreaChart
                data={data}
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => fmtDate(String(v))}
                  fontSize={11}
                />
                <YAxis tickFormatter={yTick} fontSize={11} width={56} />
                <Tooltip
                  formatter={tooltipFmt}
                  labelFormatter={(label) => fmtDate(String(label))}
                  wrapperStyle={{ zIndex: 10 }}
                />
                {sourceLabels.map((label, i) => (
                  <Area
                    key={label}
                    type="monotone"
                    dataKey={label}
                    stackId="1"
                    stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                    fill={CHART_PALETTE[i % CHART_PALETTE.length]}
                    fillOpacity={0.55}
                  />
                ))}
              </AreaChart>
            ) : (
              // Three of four modes are line charts; only stacked+CAD is areas.
              <LineChart
                data={data}
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => fmtDate(String(v))}
                  fontSize={11}
                />
                <YAxis tickFormatter={yTick} fontSize={11} width={56} />
                <Tooltip
                  formatter={tooltipFmt}
                  labelFormatter={(label) => fmtDate(String(label))}
                  wrapperStyle={{ zIndex: 10 }}
                />
                {isPct && (
                  <ReferenceLine
                    y={0}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="2 2"
                  />
                )}
                {view === "total" ? (
                  <Line
                    type="monotone"
                    dataKey={isPct ? pctKey("total") : "total"}
                    stroke={CHART_PALETTE[0]}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    name="Total"
                  />
                ) : (
                  pctSourceLabels.map((label, i) => (
                    <Line
                      key={label}
                      type="monotone"
                      dataKey={pctKey(label)}
                      stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 4 }}
                      name={label}
                    />
                  ))
                )}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>

        {/* Out-of-SVG legend so long account names wrap into card flow.
         *  Only needed when there are multiple series. */}
        {view === "stacked" && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
            {(scale === "cad" ? sourceLabels : pctSourceLabels).map((label, i) => (
              <li key={label} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
                  }}
                />
                <span>{label}</span>
              </li>
            ))}
          </ul>
        )}

        {isPct && (
          <p className="pt-1 text-xs italic text-muted-foreground">
            Balance change since first snapshot — not return. Deposits and
            withdrawals show up as steps, not gains.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Positions table — funds (split by source) + stocks aggregate
// ---------------------------------------------------------------------------

function PositionsCard({
  funds,
  stocksCad,
  stocksAsOf,
  stockPositions,
  onSnapshot,
  snapshotPending,
  snapshotDisabled,
}: {
  funds: AccountRow[];
  stocksCad: number;
  stocksAsOf: string | null;
  stockPositions: StockPortfolioRow[];
  onSnapshot: () => void;
  snapshotPending: boolean;
  snapshotDisabled: boolean;
}) {
  if (funds.length === 0 && stocksCad === 0) {
    return <EmptyPositions />;
  }

  const manualFunds = funds.filter((f) => f.source === "manual");
  const ynabFunds = funds.filter((f) => f.source === "ynab");

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Positions
          </h3>
          <Button
            onClick={onSnapshot}
            disabled={snapshotPending || snapshotDisabled}
            size="sm"
          >
            {snapshotPending ? "Snapshotting…" : "Snapshot today"}
          </Button>
        </div>

        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Position</th>
              <th className="px-4 py-2 text-right font-medium">
                Native balance
              </th>
              <th className="px-4 py-2 text-right font-medium">CAD value</th>
              <th className="px-4 py-2 text-right font-medium">Last synced</th>
            </tr>
          </thead>
          <tbody>
            {manualFunds.length > 0 && (
              <>
                <SectionRow
                  label="Manual funds — tap any balance to update"
                  tone="amber"
                  editable
                />
                {manualFunds.map((f) => (
                  <ManualFundRow key={f.id} fund={f} />
                ))}
              </>
            )}
            {ynabFunds.length > 0 && (
              <>
                <SectionRow
                  label="YNAB-linked — synced automatically"
                  tone="sky"
                />
                {ynabFunds.map((f) => (
                  <YnabFundRow key={f.id} fund={f} />
                ))}
              </>
            )}
            {stocksCad > 0 && (
              <>
                <SectionRow
                  label="Stocks — live from last quote"
                  tone="emerald"
                />
                {stockPositions.length === 0 ? (
                  <tr className="border-t">
                    <td className="px-4 py-3 font-medium">
                      Stocks (aggregate)
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      —
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {fmtCAD(stocksCad)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                      {fmtSyncTime(stocksAsOf)}
                    </td>
                  </tr>
                ) : (
                  stockPositions.map((p) => (
                    <StockRow key={p.ticker} position={p} />
                  ))
                )}
              </>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

type SectionTone = "amber" | "sky" | "emerald";

const SECTION_TONE_CLASSES: Record<
  SectionTone,
  { row: string; text: string; icon: string }
> = {
  amber: {
    row: "bg-amber-100 dark:bg-amber-500/15 border-l-4 border-amber-500",
    text: "text-amber-900 dark:text-amber-200",
    icon: "text-amber-700 dark:text-amber-300",
  },
  sky: {
    row: "bg-sky-100 dark:bg-sky-500/15 border-l-4 border-sky-500",
    text: "text-sky-900 dark:text-sky-200",
    icon: "text-sky-700 dark:text-sky-300",
  },
  emerald: {
    row: "bg-emerald-100 dark:bg-emerald-500/15 border-l-4 border-emerald-500",
    text: "text-emerald-900 dark:text-emerald-200",
    icon: "text-emerald-700 dark:text-emerald-300",
  },
};

function SectionRow({
  label,
  tone,
  editable = false,
}: {
  label: string;
  tone: SectionTone;
  editable?: boolean;
}) {
  const t = SECTION_TONE_CLASSES[tone];
  return (
    <tr className={t.row}>
      <td
        colSpan={4}
        className={cn(
          "px-4 py-2 text-xs font-bold uppercase tracking-wider",
          t.text,
        )}
      >
        {editable && (
          <i className={cn("ti ti-pencil mr-1.5", t.icon)} aria-hidden />
        )}
        {label}
      </td>
    </tr>
  );
}

function ManualFundRow({ fund }: { fund: AccountRow }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(fund.balance));
  const manualId = fund.id.replace(/^manual:/, "");

  const save = useMutation({
    mutationFn: (next: string) =>
      apiFetch(`/accounts/manual/${manualId}`, {
        method: "PATCH",
        body: JSON.stringify({ balance: next }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts-all"] });
      qc.invalidateQueries({ queryKey: ["funds-vs-stocks"] });
      setEditing(false);
    },
  });

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === String(fund.balance)) {
      setEditing(false);
      setDraft(String(fund.balance));
      return;
    }
    save.mutate(trimmed);
  }

  return (
    <tr className="border-t">
      <td className="px-4 py-3">
        <div className="font-medium">{fund.name}</div>
        {fund.bank && (
          <div className="text-xs text-muted-foreground">{fund.bank}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <div className="flex items-center justify-end gap-2">
            <Input
              type="number"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(String(fund.balance));
                }
              }}
              autoFocus
              className="h-8 w-32 text-right tabular-nums"
            />
            <span className="text-xs text-muted-foreground">
              {fund.currency}
            </span>
            {/* Surface keyboard shortcuts — Enter/blur already save, but
             *   users can't see that. Esc-to-cancel is the only one
             *   without a visible analogue, so name both for symmetry. */}
            <span className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">
              Enter to save · Esc to cancel
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${fund.name} balance`}
            className={cn(
              "group inline-flex cursor-pointer items-center gap-1.5 rounded-md",
              "border border-primary/30 bg-primary/5 px-2 py-1 tabular-nums text-foreground",
              "hover:border-primary hover:bg-primary/10",
              "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              "transition-colors",
            )}
            title="Click to edit balance"
          >
            <span>{fmtNative(fund.balance, fund.currency)}</span>
            <i
              className="ti ti-pencil text-sm text-primary/80 transition-colors group-hover:text-primary"
              aria-hidden
            />
          </button>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {fund.balance_cad === null ? "—" : fmtCAD(fund.balance_cad)}
      </td>
      <td className="px-4 py-3 text-right text-xs text-muted-foreground">
        {save.isPending ? "saving…" : fmtSyncTime(fund.balance_as_of)}
      </td>
    </tr>
  );
}

function StockRow({ position }: { position: StockPortfolioRow }) {
  const shares = num(position.shares);
  const cad = num(position.current_value_cad);
  const cost = num(position.acb_total_cad);
  const unrealCad = num(position.unrealized_cad);
  const pct = cost > 0 ? (unrealCad / cost) * 100 : null;
  return (
    <tr className="border-t">
      <td className="px-4 py-3">
        <div className="font-medium">{position.ticker}</div>
        {position.name && (
          <div className="text-xs text-muted-foreground">{position.name}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {shares.toLocaleString("en-CA", { maximumFractionDigits: 4 })}
        <span className="ml-1 text-xs text-muted-foreground">sh</span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {position.current_value_cad === null ? "—" : fmtCAD(cad)}
      </td>
      <td className="px-4 py-3 text-right text-xs tabular-nums">
        {pct === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              "font-medium",
              pct > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : pct < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground",
            )}
          >
            {fmtPct(pct)}
          </span>
        )}
      </td>
    </tr>
  );
}

function YnabFundRow({ fund }: { fund: AccountRow }) {
  return (
    <tr className="border-t">
      <td className="px-4 py-3">
        <div className="font-medium">{fund.name}</div>
        <div className="text-xs text-muted-foreground">YNAB</div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {fmtNative(fund.balance, fund.currency)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {fund.balance_cad === null ? "—" : fmtCAD(fund.balance_cad)}
      </td>
      <td className="px-4 py-3 text-right text-xs text-muted-foreground">
        {fmtSyncTime(fund.last_synced_at)}
      </td>
    </tr>
  );
}

function EmptyPositions() {
  return (
    <Card>
      <CardContent className="space-y-3 p-6 text-center">
        <h3 className="text-lg font-semibold">No investments yet</h3>
        <p className="text-sm text-muted-foreground">
          Add a manual account tagged <em>Investing — fund</em>, or record a
          stock purchase, to start tracking.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link
            to="/accounts"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Manage accounts
          </Link>
          <Link
            to="/investments/stocks/buy"
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Record a buy
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Snapshots history — one row per date, click for edit/delete modal
// ---------------------------------------------------------------------------

function SnapshotsCard({
  history,
}: {
  history: InvestingSnapshotHistoryItem[];
}) {
  // Newest first in the list — the modal can still re-fetch if needed.
  const sorted = useMemo(
    () => [...history].sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date)),
    [history],
  );
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="snapshots-list"
            className={cn(
              "flex w-full items-center justify-between gap-2 border-b px-4 py-3 text-left",
              "hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
              !expanded && "border-b-0",
            )}
          >
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <i
                className={cn(
                  "ti mr-1.5 text-base align-[-1px]",
                  expanded ? "ti-chevron-down" : "ti-chevron-right",
                )}
                aria-hidden
              />
              Snapshots
            </h3>
            <span className="text-xs text-muted-foreground">
              {sorted.length} total
            </span>
          </button>
          {expanded && (
            <ul
              id="snapshots-list"
              className="max-h-72 overflow-y-auto"
            >
              {sorted.map((item) => {
                const sources = Object.keys(item.by_source);
                return (
                  <li
                    key={item.snapshot_date}
                    className="border-t first:border-t-0"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenDate(item.snapshot_date)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left",
                        "hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                      )}
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {fmtDate(item.snapshot_date)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {sources.length} source{sources.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums">
                          {fmtCAD(item.total_cad)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          edit ›
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      {openDate && (
        <SnapshotModal
          snapshotDate={openDate}
          onClose={() => setOpenDate(null)}
        />
      )}
    </>
  );
}

function SnapshotModal({
  snapshotDate,
  onClose,
}: {
  snapshotDate: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dayQ = useQuery<InvestingSnapshotDay>({
    queryKey: ["investing-snapshot", snapshotDate],
    queryFn: () =>
      apiFetch<InvestingSnapshotDay>(
        `/investments/snapshots/${snapshotDate}`,
      ),
  });

  // Escape closes; backdrop click closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["investing-snapshot", snapshotDate] });
    qc.invalidateQueries({ queryKey: ["investing-snapshots-history"] });
  }

  const deleteDay = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/investments/snapshots/${snapshotDate}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  function confirmAndDeleteDay() {
    if (
      window.confirm(
        `Delete the ${fmtDate(snapshotDate)} snapshot? This removes every row for that date.`,
      )
    ) {
      deleteDay.mutate();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit snapshot for ${fmtDate(snapshotDate)}`}
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-base font-semibold">
              {fmtDate(snapshotDate)}
            </h3>
            <p className="text-xs text-muted-foreground">
              Edit native amounts or remove individual rows. CAD is
              recomputed using the rate captured that day.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <i className="ti ti-x" aria-hidden />
          </button>
        </div>

        <div className="p-4">
          {dayQ.isLoading && <LoadingBox />}
          {dayQ.isError && (
            <p className="text-sm text-destructive">
              Failed to load this snapshot.
            </p>
          )}
          {dayQ.data && (
            <>
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 text-right font-medium">
                      Native amount
                    </th>
                    <th className="pb-2 text-right font-medium">CAD</th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody>
                  {dayQ.data.rows.map((row) => (
                    <SnapshotRowEditor
                      key={row.id ?? `${row.source_kind}-${row.source_id}`}
                      row={row}
                      onChanged={invalidate}
                    />
                  ))}
                </tbody>
              </table>

              <div className="mt-4 flex items-center justify-between border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  Total: <strong>{fmtCAD(dayQ.data.total_cad)}</strong>
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={confirmAndDeleteDay}
                  disabled={deleteDay.isPending}
                >
                  {deleteDay.isPending
                    ? "Deleting…"
                    : "Delete entire snapshot"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SnapshotRowEditor({
  row,
  onChanged,
}: {
  row: InvestingSnapshotRow;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(String(row.native_amount));
  const [editing, setEditing] = useState(false);
  // Reset the draft if the underlying row is replaced (e.g. after invalidate).
  useEffect(() => {
    setDraft(String(row.native_amount));
  }, [row.native_amount]);

  const save = useMutation({
    mutationFn: (next: string) =>
      apiFetch<InvestingSnapshotRow>(
        `/investments/snapshots/rows/${row.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ native_amount: next }),
        },
      ),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  const del = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/investments/snapshots/rows/${row.id}`, {
        method: "DELETE",
      }),
    onSuccess: onChanged,
  });

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === String(row.native_amount)) {
      setEditing(false);
      setDraft(String(row.native_amount));
      return;
    }
    save.mutate(trimmed);
  }

  function confirmAndDelete() {
    if (window.confirm(`Delete the "${row.label}" row from this snapshot?`)) {
      del.mutate();
    }
  }

  return (
    <tr className="border-t">
      <td className="py-2 pr-2">
        <div className="font-medium">{row.label}</div>
        <div className="text-xs text-muted-foreground">
          {row.source_kind === "manual_fund"
            ? "Manual fund"
            : row.source_kind === "ynab_fund"
              ? "YNAB"
              : "Stocks aggregate"}
        </div>
      </td>
      <td className="py-2 text-right">
        {editing ? (
          <div className="flex items-center justify-end gap-1.5">
            <Input
              type="number"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(String(row.native_amount));
                }
              }}
              autoFocus
              className="h-8 w-32 text-right tabular-nums"
            />
            <span className="text-xs text-muted-foreground">
              {row.native_currency}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1",
              "tabular-nums hover:border-primary hover:bg-primary/10",
            )}
            disabled={save.isPending}
          >
            <span>{fmtNative(row.native_amount, row.native_currency)}</span>
            <i
              className="ti ti-pencil text-sm text-primary/80"
              aria-hidden
            />
          </button>
        )}
      </td>
      <td className="py-2 text-right tabular-nums text-muted-foreground">
        {save.isPending ? "saving…" : fmtCAD(row.cad_amount)}
      </td>
      <td className="py-2 pl-2 text-right">
        <button
          type="button"
          onClick={confirmAndDelete}
          disabled={del.isPending || save.isPending}
          className={cn(
            "rounded-md p-1.5 text-muted-foreground",
            "hover:bg-destructive/10 hover:text-destructive",
            "disabled:opacity-50",
          )}
          aria-label={`Delete ${row.label} row`}
          title="Delete this row"
        >
          <i className="ti ti-trash text-base" aria-hidden />
        </button>
      </td>
    </tr>
  );
}
