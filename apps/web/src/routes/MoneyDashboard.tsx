/**
 * MoneyDashboard — health-first view of the user's overall position.
 *
 * Reads `GET /money/health` and renders:
 *   - a hero strip with the anchor: total CAD net worth, plus the
 *     Personal / Business split and the YNAB last-sync timestamp,
 *   - four KPI cards: savings ratio, debt-to-income, liquidity in
 *     months, and a net-worth tile that doubles as a delta surface
 *     once we have snapshots (Phase 2).
 *
 * Phase 1 has no charts — those land with the snapshot infra. Targets
 * are baked into the backend until Phase 3 surfaces a Settings section.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch, ApiError } from "@/lib/api";
import type { MoneyHealthResponse } from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { HealthKpiCard } from "@/components/HealthKpiCard";

const CHART_COLORS = {
  checking: "hsl(217 91% 60%)", // brand blue
  savings: "hsl(158 64% 45%)", // emerald
  investing: "hsl(267 84% 65%)", // mauve
  income: "hsl(158 64% 45%)",
  expenses: "hsl(0 84% 60%)",
  netWorth: "hsl(217 91% 60%)",
  personal: "hsl(158 64% 45%)",
  business: "hsl(38 92% 50%)",
  grid: "hsl(var(--border))",
  axis: "hsl(var(--muted-foreground))",
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? null : n;
}

function fmtMoney(v: number | string | null, currency = "CAD"): string {
  const n = num(v);
  if (n === null) return "—";
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

/** Dashboard sub-navigation. Tabs are placeholders for future views
 *  (e.g. /money/dashboard/spending, /money/dashboard/trends) — only
 *  Overview is wired up today. */
function DashboardSubNav({
  active,
}: {
  active: "overview";
}) {
  const tabs: { id: "overview"; label: string }[] = [
    { id: "overview", label: "Overview" },
  ];
  return (
    <nav
      aria-label="Dashboard sections"
      className="mt-3 -mb-px flex gap-4 border-b"
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <span
            key={t.id}
            className={
              isActive
                ? "border-b-2 border-primary px-1 pb-2 text-sm font-medium text-foreground"
                : "px-1 pb-2 text-sm text-muted-foreground"
            }
            aria-current={isActive ? "page" : undefined}
          >
            {t.label}
          </span>
        );
      })}
    </nav>
  );
}

export function MoneyDashboard() {
  const { data, isLoading, isError, error } = useQuery<MoneyHealthResponse>({
    queryKey: ["money-health"],
    queryFn: () => apiFetch<MoneyHealthResponse>("/money/health"),
  });

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-2xl font-bold">Dashboard</h2>
            <span className="text-xs text-muted-foreground">
              YNAB synced{" "}
              <span className="font-medium text-foreground">
                {fmtRelative(data?.last_ynab_sync_at ?? null)}
              </span>
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            A health-first view of your overall position. Targets are
            sensible defaults; they'll be editable in a later phase.
          </p>
          <DashboardSubNav active="overview" />
        </header>

        {isError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Failed to load: {extractError(error)}
          </div>
        )}

        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {data && (
          <>
            {/* Hero: anchor net worth + owner split */}
            <Card className="mb-6">
              <CardContent className="p-6">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Net worth (CAD)
                    </p>
                    <p className="mt-1 text-4xl font-bold tabular-nums">
                      {fmtMoney(data.net_worth_cad)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fmtMoney(data.assets_cad)} assets ·{" "}
                      {fmtMoney(data.liabilities_cad)} liabilities
                    </p>
                    {(data.income_monthly_cad !== null ||
                      data.expenses_monthly_cad !== null) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Trailing 12mo · {fmtMoney(data.income_monthly_cad)} in
                        · {fmtMoney(data.expenses_monthly_cad)} out
                      </p>
                    )}
                  </div>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Personal
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">
                        {fmtMoney(data.personal_net_worth_cad)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Business
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">
                        {fmtMoney(data.business_net_worth_cad)}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* KPI strip */}
            <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <HealthKpiCard
                label="Savings ratio"
                value={num(data.savings_ratio.value)}
                unit="%"
                targetLabel={`${Number(data.savings_ratio.target).toFixed(0)}%`}
                status={data.savings_ratio.status}
                reason={data.savings_ratio.reason}
              />
              <HealthKpiCard
                label="Debt-to-income"
                value={num(data.debt_to_income.value)}
                unit="%"
                targetLabel={`<${Number(data.debt_to_income.target).toFixed(0)}%`}
                status={data.debt_to_income.status}
                reason={data.debt_to_income.reason}
              />
              <HealthKpiCard
                label="Liquidity (months)"
                value={num(data.liquidity_months.value)}
                targetLabel={`≥${Number(data.liquidity_months.target).toFixed(0)}`}
                status={data.liquidity_months.status}
                reason={data.liquidity_months.reason}
              />
              <HealthKpiCard
                label="Net worth growth"
                value={num(data.net_worth_growth.value)}
                unit="%"
                targetLabel={`≥${Number(data.net_worth_growth.target).toFixed(0)}%`}
                status={data.net_worth_growth.status}
                reason={data.net_worth_growth.reason}
              />
            </section>

            {/* Net worth trend (line) — full width to give the chart room */}
            <Card className="mb-6">
              <CardContent className="p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Net worth trend
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Monthly snapshots, oldest to newest. Captured after
                  every YNAB sync and account edit.
                </p>
                {data.net_worth_trend.length < 2 ? (
                  <p className="mt-8 text-center text-sm text-muted-foreground">
                    Not enough history yet. Come back next month — Helm
                    captures a snapshot after every balance change.
                  </p>
                ) : (
                  <div className="mt-3 h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={data.net_worth_trend.map((s) => ({
                          month: s.month.slice(0, 7), // YYYY-MM
                          net: num(s.net_worth_cad) ?? 0,
                          personal: num(s.personal_cad) ?? 0,
                          business: num(s.business_cad) ?? 0,
                        }))}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid
                          stroke={CHART_COLORS.grid}
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="month"
                          stroke={CHART_COLORS.axis}
                          fontSize={11}
                          tickLine={false}
                        />
                        <YAxis
                          stroke={CHART_COLORS.axis}
                          fontSize={11}
                          tickLine={false}
                          tickFormatter={(v: number) =>
                            v >= 1000
                              ? `${Math.round(v / 1000)}k`
                              : `${v}`
                          }
                        />
                        <Tooltip
                          formatter={((value: unknown) =>
                            fmtMoney(
                              typeof value === "number"
                                ? value
                                : Number(value),
                            )) as never}
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "6px",
                            fontSize: "12px",
                          }}
                        />
                        <Legend
                          verticalAlign="bottom"
                          height={24}
                          iconSize={8}
                          wrapperStyle={{ fontSize: "12px" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="net"
                          name="Net worth"
                          stroke={CHART_COLORS.netWorth}
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="personal"
                          name="Personal"
                          stroke={CHART_COLORS.personal}
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="business"
                          name="Business"
                          stroke={CHART_COLORS.business}
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Charts: allocation donut + monthly flows bars */}
            <section className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Asset allocation
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Where your money lives, by kind
                  </p>
                  {data.allocation.length === 0 ? (
                    <p className="mt-8 text-center text-sm text-muted-foreground">
                      No assets to allocate yet.
                    </p>
                  ) : (
                    <div className="mt-3 h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={data.allocation.map((a) => ({
                              name: a.label,
                              kind: a.kind,
                              value: num(a.cad_amount) ?? 0,
                              share: num(a.share_pct) ?? 0,
                            }))}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={50}
                            outerRadius={80}
                            paddingAngle={2}
                            stroke="hsl(var(--background))"
                            strokeWidth={2}
                          >
                            {data.allocation.map((a) => (
                              <Cell
                                key={a.kind}
                                fill={
                                  CHART_COLORS[
                                    a.kind as keyof typeof CHART_COLORS
                                  ] ?? "hsl(var(--muted))"
                                }
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={((value: unknown, _name: unknown, item: unknown) => {
                              const n = typeof value === "number" ? value : Number(value);
                              const share =
                                (item as { payload?: { share?: number } } | undefined)
                                  ?.payload?.share ?? 0;
                              const name =
                                (item as { payload?: { name?: string } } | undefined)
                                  ?.payload?.name ?? "";
                              return [`${fmtMoney(n)} (${share.toFixed(1)}%)`, name];
                            }) as never}
                            contentStyle={{
                              background: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "6px",
                              fontSize: "12px",
                            }}
                          />
                          <Legend
                            verticalAlign="bottom"
                            height={24}
                            iconSize={8}
                            wrapperStyle={{ fontSize: "12px" }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Monthly flows
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Income vs expenses, last 12 months
                  </p>
                  {data.monthly_flows.every(
                    (m) => num(m.income_cad) === 0 && num(m.expenses_cad) === 0,
                  ) ? (
                    <p className="mt-8 text-center text-sm text-muted-foreground">
                      Connect YNAB to see monthly flows.
                    </p>
                  ) : (
                    <div className="mt-3 h-56">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={data.monthly_flows.map((f) => ({
                            month: f.month.slice(5, 7), // "MM" from YYYY-MM-DD
                            income: num(f.income_cad) ?? 0,
                            expenses: num(f.expenses_cad) ?? 0,
                          }))}
                          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                        >
                          <XAxis
                            dataKey="month"
                            stroke={CHART_COLORS.axis}
                            fontSize={11}
                            tickLine={false}
                          />
                          <YAxis
                            stroke={CHART_COLORS.axis}
                            fontSize={11}
                            tickLine={false}
                            tickFormatter={(v: number) =>
                              v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`
                            }
                          />
                          <Tooltip
                            cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
                            formatter={((value: unknown) =>
                              fmtMoney(
                                typeof value === "number" ? value : Number(value),
                              )) as never}
                            contentStyle={{
                              background: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: "6px",
                              fontSize: "12px",
                            }}
                          />
                          <Legend
                            verticalAlign="bottom"
                            height={24}
                            iconSize={8}
                            wrapperStyle={{ fontSize: "12px" }}
                          />
                          <Bar
                            dataKey="income"
                            fill={CHART_COLORS.income}
                            radius={[2, 2, 0, 0]}
                          />
                          <Bar
                            dataKey="expenses"
                            fill={CHART_COLORS.expenses}
                            radius={[2, 2, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* Needs attention */}
            {data.attention.length > 0 && (
              <Card className="mb-6">
                <CardContent className="p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Needs attention
                  </p>
                  <ul className="mt-3 space-y-2">
                    {data.attention.map((a, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-3 text-sm"
                      >
                        <span
                          className={
                            a.severity === "warning"
                              ? "mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-red-500 dark:bg-red-400"
                              : "mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
                          }
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{a.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.detail}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Warnings strip */}
            {data.warnings.length > 0 && (
              <Card className="mb-6 border-amber-500/40">
                <CardContent className="p-4">
                  <p className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-500">
                    Notes
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {data.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Footer: how to drill in */}
            <p className="text-xs text-muted-foreground">
              Want the per-account breakdown?{" "}
              <Link
                to="/accounts"
                className="text-primary underline-offset-4 hover:underline"
              >
                Open Accounts
              </Link>
              .
            </p>
          </>
        )}
      </main>
    </div>
  );
}
