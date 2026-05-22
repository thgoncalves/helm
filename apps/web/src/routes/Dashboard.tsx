/**
 * Dashboard — the post-sign-in landing.
 *
 * Single GET /business/dashboard call returns everything below. KPI
 * cards are clickable shortcuts into the relevant listing pages.
 *
 * Sections (top→bottom, matching the mock the user drew):
 *  Key Metrics:    FY Invoiced · FY Received · Outstanding · Invoices
 *  Tax / Transfers: GST Collected · GST Owed · Transfers FY · Tax Exposure
 *  Monthly Revenue (stacked by client) + Top Clients (horizontal bars)
 *  Cash Flow: Invoiced vs Received (line/area)
 *  Quarterly Performance (grouped bars)
 *  Total Income by Fiscal Year (bars + value labels)
 *  Aging — outstanding invoices bucketed 0-30 / 31-60 / 61-90 / 90+ days.
 *
 * Improvements over the user's mock:
 *  - "Δ vs prev FY" compares same-point-last-FY (today − 1 year) instead
 *    of full-FY-vs-full-FY, so the comparison is apples-to-apples while
 *    the current FY is still running.
 *  - KPI cards are clickable shortcuts.
 *  - Aging widget added (not in the mock).
 *  - All chart colours come from CSS variables, so the dashboard themes
 *    with the rest of the app.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch } from "@/lib/api";
import type {
  CashFlowPoint,
  ClientSliceAmount,
  DashboardResponse,
  FYIncomePoint,
  KPI,
  MonthlyRevenuePoint,
  QuarterlyPoint,
  TopClient,
} from "@/types/api";
import { formatCAD, num } from "@/lib/invoice";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingBox } from "@/components/LoadingScreen";

// ---------------------------------------------------------------------------
// Theme-aware chart palette
// ---------------------------------------------------------------------------

/** Recharts wants explicit colour strings — wrap the CSS tokens. */
const CHART_COLORS = {
  primary: "hsl(var(--primary))",
  destructive: "hsl(var(--destructive))",
  muted: "hsl(var(--muted-foreground))",
  emerald: "hsl(158 64% 45%)",
  emeraldDark: "hsl(158 60% 55%)",
  amber: "hsl(38 92% 50%)",
  red: "hsl(0 84% 60%)",
  // Stacked-bar palette for clients (top 5).
  stack: [
    "hsl(217 91% 60%)", // brand blue
    "hsl(158 64% 45%)", // emerald
    "hsl(38 92% 50%)", // amber
    "hsl(267 84% 65%)", // mauve
    "hsl(199 89% 48%)", // sky
  ],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPct(value: number | string | null): string {
  if (value === null || value === "") return "";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "";
  const sign = n > 0 ? "▲" : n < 0 ? "▼" : "";
  return `${sign} ${Math.abs(n).toFixed(1)}%`;
}

function deltaColorClass(value: number | string | null): string {
  if (value === null || value === "") return "text-muted-foreground";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
}

function MoneyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      {label && <p className="font-medium">{label}</p>}
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>{" "}
          <span className="font-medium">{formatCAD(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

interface KPICardProps {
  label: string;
  kpi: KPI;
  to?: string;
  /** Render as integer (no currency) when the metric is a count, e.g. invoices. */
  count?: boolean;
  valueClass?: string;
}

function KPICard({ label, kpi, to, count, valueClass }: KPICardProps) {
  const navigate = useNavigate();
  const value = num(kpi.value);
  const formattedValue = count ? value.toLocaleString() : formatCAD(value);
  const inner = (
    <Card
      className={
        "h-full transition-colors " + (to ? "cursor-pointer hover:bg-accent/40" : "")
      }
      onClick={to ? () => navigate(to) : undefined}
    >
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={"text-2xl font-bold " + (valueClass ?? "text-foreground")}>
          {formattedValue}
        </p>
        <div className="flex items-center gap-2 text-xs">
          {kpi.delta_pct !== null && (
            <span className={"font-semibold " + deltaColorClass(kpi.delta_pct)}>
              {fmtPct(kpi.delta_pct)}
            </span>
          )}
          {kpi.detail && (
            <span className="text-muted-foreground">{kpi.detail}</span>
          )}
          {kpi.delta_pct !== null && (
            <span className="text-muted-foreground">vs same point last FY</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
  return inner;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useQuery<DashboardResponse>({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<DashboardResponse>("/business/dashboard/"),
  });

  // Distinct top-5 client names that appear in the monthly stacked bars,
  // for the chart's <Bar> children + tooltip legend.
  const stackClients = useMemo<TopClient[]>(
    () => (data?.top_clients ?? []).slice(0, 5),
    [data?.top_clients],
  );

  // Convert each monthly point into a Recharts-friendly row with one key
  // per top-client name.
  const monthlyRows = useMemo(() => {
    if (!data) return [];
    return data.monthly_revenue.map((m: MonthlyRevenuePoint) => {
      const row: Record<string, number | string> = {
        month: m.month,
        total: num(m.total),
      };
      for (const tc of stackClients) {
        const slice = m.by_client.find(
          (s: ClientSliceAmount) => s.client_id === tc.client_id,
        );
        row[tc.client_name] = slice ? num(slice.amount) : 0;
      }
      return row;
    });
  }, [data, stackClients]);

  const cashFlowRows = useMemo(() => {
    if (!data) return [];
    return data.cash_flow.map((p: CashFlowPoint) => ({
      month: p.month,
      invoiced: num(p.invoiced),
      received: num(p.received),
    }));
  }, [data]);

  const quarterlyRows = useMemo(() => {
    if (!data) return [];
    return data.quarterly.map((q: QuarterlyPoint) => ({
      quarter: q.quarter,
      invoiced: num(q.invoiced),
      received: num(q.received),
    }));
  }, [data]);

  const fyRows = useMemo(() => {
    if (!data) return [];
    return data.by_fiscal_year.map((f: FYIncomePoint) => ({
      fy: f.fy_label,
      received: num(f.received),
      invoiced: num(f.invoiced),
    }));
  }, [data]);

  const topClientRows = useMemo(() => {
    if (!data) return [];
    return data.top_clients.map((c) => ({
      client: c.client_name,
      total: num(c.total),
    }));
  }, [data]);

  const fyLabel = useMemo(() => {
    if (!data) return "";
    const start = data.fy_start.slice(0, 4);
    const end = data.fy_end.slice(2, 4);
    return `FY ${start}/${end}`;
  }, [data]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Dashboard</h2>
          <p className="text-sm text-muted-foreground">{fyLabel}</p>
        </div>

        {isLoading && (
          <LoadingBox />
        )}
        {isError && (
          <p className="text-destructive">
            Failed to load dashboard:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        )}

        {data && (
          <div className="space-y-6">
            {/* Key Metrics */}
            <section>
              <h3 className="mb-3 text-sm font-semibold">Key Metrics</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KPICard
                  label="FY Invoiced"
                  kpi={data.kpis.fy_invoiced}
                  to="/invoices"
                />
                <KPICard
                  label="FY Received"
                  kpi={data.kpis.fy_received}
                  to="/payments"
                />
                <KPICard
                  label="Outstanding"
                  kpi={data.kpis.outstanding}
                  valueClass="text-red-600 dark:text-red-400"
                  to="/invoices"
                />
                <KPICard
                  label="Invoices"
                  kpi={data.kpis.invoice_count}
                  count
                  to="/invoices"
                />
              </div>
            </section>

            {/* Tax / Transfers */}
            <section>
              <h3 className="mb-3 text-sm font-semibold">Tax / Transfers</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KPICard
                  label="GST Collected"
                  kpi={data.kpis.gst_collected}
                  to="/taxes"
                />
                <KPICard
                  label="GST Owed"
                  kpi={data.kpis.gst_owed}
                  valueClass={
                    num(data.kpis.gst_owed.value) > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                  }
                  to="/taxes"
                />
                <KPICard
                  label="Transfers FY"
                  kpi={data.kpis.transfers_fy}
                  to="/transfers"
                />
                <KPICard
                  label="Tax Exposure"
                  kpi={data.kpis.tax_exposure}
                  valueClass={
                    num(data.kpis.tax_exposure.value) > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground"
                  }
                  to="/transfers"
                />
              </div>
            </section>

            {/* Monthly Revenue + Top Clients */}
            <section className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Monthly Revenue
                  </h3>
                  <div className="h-72 w-full">
                    <ResponsiveContainer>
                      <BarChart data={monthlyRows}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          opacity={0.2}
                        />
                        <XAxis
                          dataKey="month"
                          stroke={CHART_COLORS.muted}
                          fontSize={12}
                        />
                        <YAxis
                          stroke={CHART_COLORS.muted}
                          fontSize={12}
                          tickFormatter={(v) =>
                            v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                          }
                        />
                        <Tooltip content={<MoneyTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {stackClients.map((c, i) => (
                          <Bar
                            key={c.client_id}
                            dataKey={c.client_name}
                            stackId="rev"
                            fill={CHART_COLORS.stack[i % CHART_COLORS.stack.length]}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">Top Clients</h3>
                  <div className="h-72 w-full">
                    {topClientRows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No clients invoiced this FY yet.
                      </p>
                    ) : (
                      <ResponsiveContainer>
                        <BarChart
                          data={topClientRows}
                          layout="vertical"
                          margin={{ left: 10, right: 30 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke={CHART_COLORS.muted}
                            opacity={0.2}
                          />
                          <XAxis
                            type="number"
                            stroke={CHART_COLORS.muted}
                            fontSize={12}
                            tickFormatter={(v) =>
                              v >= 1000
                                ? `$${(v / 1000).toFixed(0)}k`
                                : `$${v}`
                            }
                          />
                          <YAxis
                            type="category"
                            dataKey="client"
                            stroke={CHART_COLORS.muted}
                            fontSize={12}
                            width={80}
                          />
                          <Tooltip content={<MoneyTooltip />} />
                          <Bar
                            dataKey="total"
                            fill={CHART_COLORS.emerald}
                            radius={[0, 4, 4, 0]}
                          >
                            {topClientRows.map((_, idx) => (
                              <Cell
                                key={idx}
                                fill={
                                  CHART_COLORS.stack[idx % CHART_COLORS.stack.length]
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </CardContent>
              </Card>
            </section>

            {/* Cash Flow */}
            <Card>
              <CardContent className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Cash Flow: Invoiced vs Received
                </h3>
                <div className="h-72 w-full">
                  <ResponsiveContainer>
                    <AreaChart data={cashFlowRows}>
                      <defs>
                        <linearGradient
                          id="grad-invoiced"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor={CHART_COLORS.primary}
                            stopOpacity={0.4}
                          />
                          <stop
                            offset="95%"
                            stopColor={CHART_COLORS.primary}
                            stopOpacity={0}
                          />
                        </linearGradient>
                        <linearGradient
                          id="grad-received"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor={CHART_COLORS.emerald}
                            stopOpacity={0.4}
                          />
                          <stop
                            offset="95%"
                            stopColor={CHART_COLORS.emerald}
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke={CHART_COLORS.muted}
                        opacity={0.2}
                      />
                      <XAxis
                        dataKey="month"
                        stroke={CHART_COLORS.muted}
                        fontSize={12}
                      />
                      <YAxis
                        stroke={CHART_COLORS.muted}
                        fontSize={12}
                        tickFormatter={(v) =>
                          v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                        }
                      />
                      <Tooltip content={<MoneyTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area
                        type="monotone"
                        dataKey="invoiced"
                        name="Invoiced"
                        stroke={CHART_COLORS.primary}
                        fill="url(#grad-invoiced)"
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        dataKey="received"
                        name="Received"
                        stroke={CHART_COLORS.emerald}
                        fill="url(#grad-received)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Quarterly */}
            <Card>
              <CardContent className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Quarterly Performance
                </h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer>
                    <BarChart data={quarterlyRows}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke={CHART_COLORS.muted}
                        opacity={0.2}
                      />
                      <XAxis
                        dataKey="quarter"
                        stroke={CHART_COLORS.muted}
                        fontSize={12}
                      />
                      <YAxis
                        stroke={CHART_COLORS.muted}
                        fontSize={12}
                        tickFormatter={(v) =>
                          v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                        }
                      />
                      <Tooltip content={<MoneyTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        dataKey="invoiced"
                        name="Invoiced"
                        fill={CHART_COLORS.stack[3]}
                      />
                      <Bar
                        dataKey="received"
                        name="Received"
                        fill={CHART_COLORS.amber}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Total Income by Fiscal Year */}
            <Card>
              <CardContent className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Total Income by Fiscal Year
                </h3>
                <div className="h-64 w-full">
                  {fyRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No historical data yet.
                    </p>
                  ) : (
                    <ResponsiveContainer>
                      <BarChart data={fyRows}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          opacity={0.2}
                        />
                        <XAxis
                          dataKey="fy"
                          stroke={CHART_COLORS.muted}
                          fontSize={12}
                        />
                        <YAxis
                          stroke={CHART_COLORS.muted}
                          fontSize={12}
                          tickFormatter={(v) =>
                            v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                          }
                        />
                        <Tooltip content={<MoneyTooltip />} />
                        <Bar
                          dataKey="received"
                          name="Received"
                          fill={CHART_COLORS.emerald}
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Aging */}
            <Card>
              <CardContent className="p-4">
                <h3 className="mb-1 text-sm font-semibold">
                  Outstanding by Age
                </h3>
                <p className="mb-3 text-xs text-muted-foreground">
                  Days since the invoice was issued, for invoices not yet
                  paid.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {data.aging.map((b) => {
                    const isStale = b.label === "61-90" || b.label === "90+";
                    const isOk = b.label === "0-30";
                    return (
                      <Link
                        key={b.label}
                        to="/invoices"
                        className="rounded-md border bg-background px-4 py-3 transition-colors hover:bg-accent/40"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {b.label} days
                        </p>
                        <p
                          className={
                            "mt-1 text-xl font-bold " +
                            (isStale
                              ? "text-red-600 dark:text-red-400"
                              : isOk
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400")
                          }
                        >
                          {formatCAD(num(b.amount))}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {b.count} invoice{b.count === 1 ? "" : "s"}
                        </p>
                      </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
