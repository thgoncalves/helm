/**
 * Investments — portfolio overview.
 *
 * Single GET /investments/portfolio/ returns everything: totals, the
 * per-account-kind rollup, allocation drift, the holdings table, and
 * the FX rates that fed the conversion. Mirrors the Business Dashboard's
 * layout vocabulary (KPI grid + Recharts + Card panels + theme tokens).
 *
 * The page is read-only — adding accounts / holdings / targets happens
 * on the dedicated sub-pages reachable from the header nav.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

import { apiFetch } from "@/lib/api";
import type {
  ContributionRoom,
  PortfolioAllocationRow,
  PortfolioByKind,
  PortfolioHolding,
  PortfolioResponse,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { labelForAccountKind } from "@/lib/accountKind";
import { labelForAssetClass } from "@/lib/assetClass";
import { cn } from "@/lib/utils";

const CHART_COLORS = {
  primary: "hsl(var(--primary))",
  muted: "hsl(var(--muted-foreground))",
  palette: [
    "hsl(217 91% 60%)",
    "hsl(158 64% 45%)",
    "hsl(38 92% 50%)",
    "hsl(267 84% 65%)",
    "hsl(199 89% 48%)",
    "hsl(0 84% 60%)",
    "hsl(48 95% 53%)",
  ],
} as const;

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

function fmtCAD(v: number | string | null): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  }).format(num(v));
}

function fmtPct(v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/**
 * Render a drift value with a directional glyph in addition to color,
 * so the over/under signal isn't color-only (a colour-blind reader
 * can't otherwise tell amber-over from sky-under).
 */
function fmtDrift(v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (Number.isNaN(n)) return "—";
  const arrow = n > 0.05 ? "▲ " : n < -0.05 ? "▼ " : "";
  return `${arrow}${Math.abs(n).toFixed(1)}%`;
}

function driftClass(drift: number | string | null): string {
  if (drift === null) return "text-muted-foreground";
  const n = typeof drift === "string" ? Number(drift) : drift;
  if (Number.isNaN(n) || Math.abs(n) < 1) return "text-muted-foreground";
  return n > 0
    ? "text-amber-600 dark:text-amber-400"
    : "text-sky-600 dark:text-sky-400";
}

export function Investments() {
  const { data, isLoading, isError, error } = useQuery<PortfolioResponse>({
    queryKey: ["investments-portfolio"],
    queryFn: () => apiFetch<PortfolioResponse>("/investments/portfolio/"),
  });
  const roomQ = useQuery<ContributionRoom[]>({
    queryKey: ["contribution-room"],
    queryFn: () =>
      apiFetch<ContributionRoom[]>("/investments/contributions/room"),
  });

  const allocationPie = useMemo(() => {
    if (!data) return [];
    return data.allocation
      .filter((r) => num(r.market_value) > 0)
      .map((r) => ({
        name: labelForAssetClass(r.asset_class),
        value: num(r.market_value),
      }));
  }, [data]);

  const isEmpty =
    data && num(data.totals.market_value) === 0 && data.holdings.length === 0;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-bold">Investments</h2>
            <p className="text-sm text-muted-foreground">
              {data
                ? `Portfolio as of ${data.as_of} · ${data.currency}`
                : "Portfolio tracker"}
            </p>
          </div>
          {data && data.fx_rates_used.length > 0 && (
            <p className="text-xs text-muted-foreground">
              FX:{" "}
              {data.fx_rates_used
                .map(
                  (fx) =>
                    `${fx.pair.replace("_", "→")} ${num(fx.rate).toFixed(4)} (${fx.rate_date})`,
                )
                .join("  ·  ")}
            </p>
          )}
        </div>

        {isLoading && (
          <p className="text-muted-foreground">Loading portfolio…</p>
        )}
        {isError && (
          <p className="text-destructive">
            Failed to load portfolio:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        )}

        {isEmpty && <EmptyState />}

        {data && !isEmpty && (
          <div className="space-y-6">
            {/* KPI grid */}
            <section>
              <h3 className="mb-3 text-sm font-semibold">Totals</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KPICard
                  label="Market value"
                  value={fmtCAD(data.totals.market_value)}
                />
                <KPICard
                  label="Cost basis"
                  value={fmtCAD(data.totals.cost_basis)}
                />
                <KPICard
                  label="Unrealised"
                  value={fmtCAD(data.totals.unrealized)}
                  valueClass={
                    num(data.totals.unrealized) < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                />
                <KPICard
                  label="Unrealised %"
                  value={fmtPct(data.totals.unrealized_pct)}
                  valueClass={
                    num(data.totals.unrealized_pct) < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                />
              </div>
            </section>

            {/* Allocation pie + drift table */}
            <section className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1.4fr]">
              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Allocation by asset class
                  </h3>
                  <div className="h-72 w-full">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie
                          data={allocationPie}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={90}
                          paddingAngle={1}
                        >
                          {allocationPie.map((_, idx) => (
                            <Cell
                              key={idx}
                              fill={
                                CHART_COLORS.palette[
                                  idx % CHART_COLORS.palette.length
                                ]
                              }
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v: unknown) => fmtCAD(num(v as number))}
                          contentStyle={{
                            background: "hsl(var(--popover))",
                            color: "hsl(var(--popover-foreground))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "0.375rem",
                          }}
                        />
                        <Legend
                          verticalAlign="bottom"
                          height={36}
                          wrapperStyle={{ fontSize: "0.75rem" }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">
                      Allocation vs target
                    </h3>
                    <Link
                      to="/investments/targets"
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Edit targets →
                    </Link>
                  </div>
                  <AllocationTable rows={data.allocation} />
                </CardContent>
              </Card>
            </section>

            {/* By account kind */}
            <section>
              <Card>
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">By account type</h3>
                    <Link
                      to="/investments/accounts"
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Manage accounts →
                    </Link>
                  </div>
                  <ByKindTable rows={data.by_account_kind} />
                </CardContent>
              </Card>
            </section>

            {/* Registered-room widget (only renders if any account has a
                contribution_limit set; otherwise the endpoint returns []). */}
            {roomQ.data && roomQ.data.length > 0 && (
              <section>
                <Card>
                  <CardContent className="p-4">
                    <h3 className="mb-3 text-sm font-semibold">
                      Contribution room (this calendar year)
                    </h3>
                    <RoomTable rows={roomQ.data} />
                  </CardContent>
                </Card>
              </section>
            )}

            {/* Holdings table */}
            <section>
              <Card>
                <CardContent className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Holdings</h3>
                    <Link
                      to="/investments/holdings/new"
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Add holding →
                    </Link>
                  </div>
                  <HoldingsTable holdings={data.holdings} />
                </CardContent>
              </Card>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function KPICard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "text-2xl font-bold",
            valueClass ?? "text-foreground",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function AllocationTable({ rows }: { rows: PortfolioAllocationRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Set target allocations to see drift here.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-2 text-left font-medium">Asset class</th>
          <th className="py-2 text-right font-medium">Value</th>
          <th className="py-2 text-right font-medium">Actual</th>
          <th className="py-2 text-right font-medium">Target</th>
          <th className="py-2 text-right font-medium">Drift</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.asset_class}
            className="border-b border-border/50 last:border-b-0"
          >
            <td className="py-2">{labelForAssetClass(r.asset_class)}</td>
            <td className="py-2 text-right tabular-nums">
              {fmtCAD(r.market_value)}
            </td>
            <td className="py-2 text-right tabular-nums">
              {num(r.actual_pct).toFixed(1)}%
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {r.target_pct !== null ? `${num(r.target_pct).toFixed(1)}%` : "—"}
            </td>
            <td
              className={cn(
                "py-2 text-right tabular-nums font-medium",
                driftClass(r.drift_pct),
              )}
            >
              {fmtDrift(r.drift_pct)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RoomTable({ rows }: { rows: ContributionRoom[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-2 text-left font-medium">Account</th>
          <th className="py-2 text-right font-medium">Limit</th>
          <th className="py-2 text-right font-medium">Contributed YTD</th>
          <th className="py-2 text-right font-medium">Remaining</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const remaining = num(r.remaining);
          const limit = num(r.contribution_limit);
          const ytd = num(r.contributed_ytd);
          const overContributed = remaining < 0;
          return (
            <tr
              key={r.account_id}
              className="border-b border-border/50 last:border-b-0"
            >
              <td className="py-2">
                <Link
                  to={`/investments/accounts/${r.account_id}/contributions`}
                  className="font-medium text-foreground hover:underline"
                >
                  {r.account_name}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">
                  {labelForAccountKind(r.account_kind)}
                </span>
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {fmtCAD(limit)}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {fmtCAD(ytd)}
              </td>
              <td
                className={cn(
                  "py-2 text-right tabular-nums font-medium",
                  overContributed
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {overContributed ? "−" : ""}
                {fmtCAD(Math.abs(remaining))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ByKindTable({ rows }: { rows: PortfolioByKind[] }) {
  const populated = rows.filter((r) => num(r.market_value) > 0);
  if (populated.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No accounts yet.</p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-2 text-left font-medium">Account type</th>
          <th className="py-2 text-right font-medium">Value (CAD)</th>
          <th className="py-2 text-right font-medium">Share</th>
        </tr>
      </thead>
      <tbody>
        {populated.map((r) => (
          <tr key={r.kind} className="border-b border-border/50 last:border-b-0">
            <td className="py-2">{labelForAccountKind(r.kind)}</td>
            <td className="py-2 text-right tabular-nums">
              {fmtCAD(r.market_value)}
            </td>
            <td className="py-2 text-right tabular-nums text-muted-foreground">
              {r.share_pct !== null ? `${num(r.share_pct).toFixed(1)}%` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HoldingsTable({ holdings }: { holdings: PortfolioHolding[] }) {
  if (holdings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No holdings yet.</p>
    );
  }

  // Group by account so the user can find a position fast even with ~30
  // holdings across 5 account kinds. Each group has its own subtotal row.
  // The portfolio endpoint already returns holdings sorted by
  // (account_name, ticker), so a simple iteration preserves order.
  type Group = {
    account_id: string;
    account_name: string;
    account_kind: string;
    rows: PortfolioHolding[];
    subtotal_cad: number;
    subtotal_unrealized: number;
  };
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const h of holdings) {
    if (!current || current.account_id !== h.account_id) {
      current = {
        account_id: h.account_id,
        account_name: h.account_name,
        account_kind: h.account_kind,
        rows: [],
        subtotal_cad: 0,
        subtotal_unrealized: 0,
      };
      groups.push(current);
    }
    current.rows.push(h);
    current.subtotal_cad += num(h.market_value_cad);
    current.subtotal_unrealized += num(h.unrealized);
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.account_id} className="overflow-x-auto">
          <div className="mb-1 flex items-baseline justify-between">
            <h4 className="text-sm font-semibold">
              {g.account_name}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {labelForAccountKind(g.account_kind)}
              </span>
            </h4>
            <p className="text-xs text-muted-foreground">
              <span className="tabular-nums font-medium text-foreground">
                {fmtCAD(g.subtotal_cad)}
              </span>
              <span
                className={cn(
                  "ml-2 tabular-nums",
                  g.subtotal_unrealized < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {g.subtotal_unrealized >= 0 ? "+" : ""}
                {fmtCAD(g.subtotal_unrealized)}
              </span>
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th className="sticky left-0 bg-card py-2 text-left font-medium">
                  Ticker
                </th>
                <th className="py-2 text-left font-medium">Class</th>
                <th className="py-2 text-right font-medium">Shares</th>
                <th className="py-2 text-right font-medium">Price</th>
                <th className="py-2 text-right font-medium">
                  Value (CAD)
                </th>
                <th className="py-2 text-right font-medium">Unrealised</th>
                <th className="py-2 text-right font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((h) => (
                <tr
                  key={h.id}
                  className="border-b border-border/50 last:border-b-0"
                >
                  <td className="sticky left-0 bg-card py-2">
                    <Link
                      to={`/investments/holdings/${h.id}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {h.ticker}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {h.currency}
                    </span>
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {labelForAssetClass(h.asset_class)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {num(h.shares).toLocaleString("en-CA", {
                      maximumFractionDigits: 4,
                    })}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {num(h.current_price).toLocaleString("en-CA", {
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {fmtCAD(h.market_value_cad)}
                  </td>
                  <td
                    className={cn(
                      "py-2 text-right tabular-nums",
                      num(h.unrealized) < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {fmtCAD(h.unrealized)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {fmtPct(h.unrealized_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="space-y-3 p-6 text-center">
        <h3 className="text-lg font-semibold">Start by adding an account</h3>
        <p className="text-sm text-muted-foreground">
          Add your Scotia iTrade, RRSP / TFSA, Brazilian and corp accounts —
          then add holdings to each. Helm rolls everything into a single
          CAD view, with Bank of Canada FX for BRL.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Link
            to="/investments/accounts"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add accounts
          </Link>
          <Link
            to="/investments/targets"
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Set target allocation
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
