/**
 * MoneyDashboard — YNAB-driven macro view for personal cash flow.
 *
 * Single GET /money/dashboard call returns everything below. The page
 * mirrors the Business Dashboard's layout (KPI grid + Recharts + theme
 * tokens) so the two modules feel like the same product. A "Last synced
 * … · Refresh" bar at the top lets the user pull a fresh snapshot from
 * YNAB on demand — the dashboard itself never talks to YNAB, only to
 * Helm's Postgres cache.
 *
 * Sections:
 *  Key metrics:   Spent · Income · Net · Categories over budget (count)
 *  Pacing:        daily cumulative spend vs linear daily budget
 *  Categories:    top 8 category groups (horizontal bar)
 *  Trailing 3M:   per-group spend (grouped bars)
 *  Over budget:   the bill-over-budget widget (sorted by overage DESC)
 *
 * The "no YNAB connected" empty state points at Settings → YNAB so the
 * user can drop in a Personal Access Token and run the first sync.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  MoneyCategoryGroupSpend,
  MoneyCategoryOverage,
  MoneyDashboardResponse,
  MoneyT3MGroupRow,
  YnabStatusResponse,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHART_COLORS = {
  primary: "hsl(var(--primary))",
  destructive: "hsl(var(--destructive))",
  muted: "hsl(var(--muted-foreground))",
  emerald: "hsl(158 64% 45%)",
  amber: "hsl(38 92% 50%)",
  red: "hsl(0 84% 60%)",
  stack: [
    "hsl(217 91% 60%)",
    "hsl(158 64% 45%)",
    "hsl(38 92% 50%)",
  ],
} as const;

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
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${n.toFixed(0)}`;
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

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function MoneyTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
  currency: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      {label !== undefined && (
        <p className="font-medium">
          {typeof label === "number" ? `Day ${label}` : label}
        </p>
      )}
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>{" "}
          <span className="font-medium">
            {fmtMoney(entry.value, currency)}
          </span>
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MoneyDashboard() {
  const queryClient = useQueryClient();

  const statusQ = useQuery<YnabStatusResponse>({
    queryKey: ["money-ynab-status"],
    queryFn: () =>
      apiFetch<YnabStatusResponse>("/money/integrations/ynab/status"),
  });

  const dashboardQ = useQuery<MoneyDashboardResponse>({
    queryKey: ["money-dashboard"],
    queryFn: () => apiFetch<MoneyDashboardResponse>("/money/dashboard/"),
    enabled: statusQ.data?.token_configured === true,
  });

  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ updated_at: string }>("/money/ynab/refresh", {
        method: "POST",
      }),
    onSuccess: () => {
      setRefreshError(null);
      void queryClient.invalidateQueries({ queryKey: ["money-dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["money-ynab-status"] });
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : String(err);
      setRefreshError(msg);
    },
  });

  const data = dashboardQ.data;
  const currency = data?.currency ?? "CAD";

  const pacingRows = useMemo(
    () =>
      (data?.pacing ?? []).map((p) => ({
        day: p.day,
        cumulative: num(p.cumulative),
        expected: num(p.expected),
      })),
    [data?.pacing],
  );

  const topGroupRows = useMemo(
    () =>
      (data?.top_groups ?? ([] as MoneyCategoryGroupSpend[])).map((g) => ({
        group: g.group_name,
        amount: num(g.amount),
      })),
    [data?.top_groups],
  );

  const t3mRows = useMemo(
    () =>
      (data?.trailing_3m ?? ([] as MoneyT3MGroupRow[])).map((r) => ({
        group: r.group_name,
        m_minus_2: num(r.m_minus_2),
        m_minus_1: num(r.m_minus_1),
        m_current: num(r.m_minus_0),
      })),
    [data?.trailing_3m],
  );

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-bold">Money</h2>
            <p className="text-sm text-muted-foreground">
              {data
                ? `${new Date(data.month).toLocaleString("en-CA", {
                    month: "long",
                    year: "numeric",
                  })} · ${currency}`
                : "YNAB-driven macro dashboard"}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Last synced{" "}
              <span className="font-medium text-foreground">
                {fmtRelative(
                  data?.last_synced_at ?? statusQ.data?.last_synced_at ?? null,
                )}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !statusQ.data?.token_configured || refreshMutation.isPending
              }
              onClick={() => refreshMutation.mutate()}
            >
              {refreshMutation.isPending ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        {refreshError && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {refreshError}
          </div>
        )}

        {/* No YNAB configured — empty state pointing at Settings. */}
        {statusQ.isSuccess && !statusQ.data?.token_configured && (
          <EmptyState />
        )}

        {statusQ.data?.token_configured && dashboardQ.isLoading && (
          <p className="text-muted-foreground">Loading dashboard…</p>
        )}
        {dashboardQ.isError && (
          <p className="text-destructive">
            Failed to load dashboard:{" "}
            {dashboardQ.error instanceof Error
              ? dashboardQ.error.message
              : "Unknown error"}
          </p>
        )}

        {data && (
          <div className="space-y-6">
            {/* Key metrics */}
            <section>
              <h3 className="mb-3 text-sm font-semibold">Key metrics</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KPICard label="Spent this month" value={fmtMoney(data.spent, currency)} />
                <KPICard
                  label="Income this month"
                  value={fmtMoney(data.income, currency)}
                  valueClass="text-emerald-600 dark:text-emerald-400"
                />
                <KPICard
                  label="Net"
                  value={fmtMoney(data.net, currency)}
                  valueClass={
                    num(data.net) < 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                  }
                />
                <KPICard
                  label="Categories over budget"
                  value={data.categories_over_budget_count.toLocaleString()}
                  valueClass={
                    data.categories_over_budget_count > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                  }
                />
              </div>
            </section>

            {/* Pacing + Bill-over-budget */}
            <section className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr]">
              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Daily pacing (cumulative vs expected)
                  </h3>
                  <div className="h-72 w-full">
                    <ResponsiveContainer>
                      <AreaChart data={pacingRows}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          opacity={0.2}
                        />
                        <XAxis dataKey="day" stroke={CHART_COLORS.muted} />
                        <YAxis
                          stroke={CHART_COLORS.muted}
                          tickFormatter={(v: number) =>
                            fmtMoney(v, currency)
                          }
                        />
                        <Tooltip
                          content={<MoneyTooltip currency={currency} />}
                        />
                        <Legend />
                        <Area
                          dataKey="cumulative"
                          name="Actual"
                          stroke={CHART_COLORS.primary}
                          fill={CHART_COLORS.primary}
                          fillOpacity={0.2}
                        />
                        <Line
                          dataKey="expected"
                          name="Expected"
                          stroke={CHART_COLORS.emerald}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Over budget this month
                  </h3>
                  {data.overages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      All categories on budget — nice.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {data.overages.map((o: MoneyCategoryOverage) => (
                        <li
                          key={o.category_id}
                          className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {o.category_name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {o.group_name}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                              +{fmtMoney(o.overage, currency)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {fmtMoney(o.activity, currency)} of{" "}
                              {fmtMoney(o.assigned, currency)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* Top categories + Trailing 3M */}
            <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Top category groups
                  </h3>
                  <div className="h-72 w-full">
                    <ResponsiveContainer>
                      <BarChart data={topGroupRows} layout="vertical">
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          opacity={0.2}
                        />
                        <XAxis
                          type="number"
                          stroke={CHART_COLORS.muted}
                          tickFormatter={(v: number) =>
                            fmtMoney(v, currency)
                          }
                        />
                        <YAxis
                          type="category"
                          dataKey="group"
                          stroke={CHART_COLORS.muted}
                          width={120}
                        />
                        <Tooltip
                          content={<MoneyTooltip currency={currency} />}
                        />
                        <Bar
                          dataKey="amount"
                          name="Spent"
                          fill={CHART_COLORS.primary}
                          radius={[0, 4, 4, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Trailing 3 months (by group)
                  </h3>
                  <div className="h-72 w-full">
                    <ResponsiveContainer>
                      <BarChart data={t3mRows}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke={CHART_COLORS.muted}
                          opacity={0.2}
                        />
                        <XAxis
                          dataKey="group"
                          stroke={CHART_COLORS.muted}
                          interval={0}
                          tick={{ fontSize: 11 }}
                        />
                        <YAxis
                          stroke={CHART_COLORS.muted}
                          tickFormatter={(v: number) =>
                            fmtMoney(v, currency)
                          }
                        />
                        <Tooltip
                          content={<MoneyTooltip currency={currency} />}
                        />
                        <Legend />
                        <Bar
                          dataKey="m_minus_2"
                          name="2 mo ago"
                          fill={CHART_COLORS.stack[2]}
                          radius={[2, 2, 0, 0]}
                        />
                        <Bar
                          dataKey="m_minus_1"
                          name="Last month"
                          fill={CHART_COLORS.stack[1]}
                          radius={[2, 2, 0, 0]}
                        />
                        <Bar
                          dataKey="m_current"
                          name="This month"
                          fill={CHART_COLORS.stack[0]}
                          radius={[2, 2, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
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

function EmptyState() {
  return (
    <Card>
      <CardContent className="space-y-3 p-6 text-center">
        <h3 className="text-lg font-semibold">Connect YNAB to get started</h3>
        <p className="text-sm text-muted-foreground">
          Helm reads your budget on demand using a YNAB Personal Access Token.
          Add one from Settings to populate this dashboard.
        </p>
        <div>
          <Link
            to="/settings#ynab"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Settings → YNAB
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
