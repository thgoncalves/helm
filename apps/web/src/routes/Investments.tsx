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
import { useMemo, useState } from "react";
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
    comparisonQ.isLoading || accountsQ.isLoading || historyQ.isLoading;

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
          onSnapshot={() => snapshotMutation.mutate()}
          snapshotPending={snapshotMutation.isPending}
          snapshotDisabled={fundAccounts.length === 0 && stocksCad === 0}
        />
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

  // Bases for percent-change rebasing — first non-zero value per series.
  // A source that's always zero gets no base and is skipped in pct mode.
  const bases = useMemo(() => {
    const out: { total: number | null; bySource: Record<string, number | null> } = {
      total: null,
      bySource: {},
    };
    for (const item of history) {
      if (out.total === null) {
        const t = num(item.total_cad);
        if (t !== 0) out.total = t;
      }
    }
    for (const label of sourceLabels) {
      let base: number | null = null;
      for (const item of history) {
        const v = num(item.by_source[label] ?? 0);
        if (v !== 0) {
          base = v;
          break;
        }
      }
      out.bySource[label] = base;
    }
    return out;
  }, [history, sourceLabels]);

  const data = useMemo(
    () =>
      history.map((item) => {
        const row: Record<string, number | string> = {
          date: item.snapshot_date,
          total: num(item.total_cad),
        };
        for (const label of sourceLabels) {
          row[label] = num(item.by_source[label] ?? 0);
        }
        // Percent-change keys — independent of the CAD keys so the
        // chart can swap series without re-shaping data on every toggle.
        if (bases.total !== null) {
          row[pctKey("total")] = ((num(item.total_cad) / bases.total) - 1) * 100;
        }
        for (const label of sourceLabels) {
          const base = bases.bySource[label];
          if (base !== null) {
            row[pctKey(label)] =
              ((num(item.by_source[label] ?? 0) / base) - 1) * 100;
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
  onSnapshot,
  snapshotPending,
  snapshotDisabled,
}: {
  funds: AccountRow[];
  stocksCad: number;
  stocksAsOf: string | null;
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
                  editable
                />
                {manualFunds.map((f) => (
                  <ManualFundRow key={f.id} fund={f} />
                ))}
              </>
            )}
            {ynabFunds.length > 0 && (
              <>
                <SectionRow label="YNAB-linked — synced automatically" />
                {ynabFunds.map((f) => (
                  <YnabFundRow key={f.id} fund={f} />
                ))}
              </>
            )}
            {stocksCad > 0 && (
              <>
                <SectionRow label="Stocks — live from last quote" />
                <tr className="border-t">
                  <td className="px-4 py-3 font-medium">Stocks (aggregate)</td>
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
              </>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SectionRow({
  label,
  editable = false,
}: {
  label: string;
  editable?: boolean;
}) {
  return (
    <tr className="bg-muted/30">
      <td
        colSpan={4}
        className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {editable && (
          <i className="ti ti-pencil mr-1.5 text-primary" aria-hidden />
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
