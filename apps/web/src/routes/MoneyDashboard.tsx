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

import { apiFetch, ApiError } from "@/lib/api";
import type { MoneyHealthResponse } from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HealthKpiCard } from "@/components/HealthKpiCard";

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
            <h2 className="text-2xl font-bold">Money</h2>
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
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Monthly income · expenses
                  </p>
                  <p className="mt-1 text-base font-semibold tabular-nums">
                    {fmtMoney(data.income_monthly_cad)}
                    <span className="text-muted-foreground"> · </span>
                    {fmtMoney(data.expenses_monthly_cad)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Trailing 12 months · CAD
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Net worth trend chart lands in Phase 2 (needs
                    snapshot history).
                  </p>
                </CardContent>
              </Card>
            </section>

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
