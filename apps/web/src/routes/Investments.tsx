/**
 * Investments — portfolio overview.
 *
 * Funds vs Stocks comparison: bank-managed balances vs self-managed
 * equity positions, both FX-converted to CAD. Funds come from accounts
 * tagged investing_fund (YNAB-synced or manual); Stocks come from
 * stock_transactions (per-lot ACB + Twelve Data quotes).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiFetch } from "@/lib/api";
import type {
  FundsVsStocksResponse,
  FundsVsStocksRow,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LoadingBox } from "@/components/LoadingScreen";

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

/** Like fmtCAD but keeps cents — for small amounts like unrealized P&L
 *  that can round to $0 under whole-dollar formatting. */
function fmtCADPrecise(v: number | string | null): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
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

export function Investments() {
  const { data, isLoading, isError, error } = useQuery<FundsVsStocksResponse>({
    queryKey: ["funds-vs-stocks"],
    queryFn: () =>
      apiFetch<FundsVsStocksResponse>("/investments/stocks/comparison"),
  });

  const isEmpty = !data || num(data.total_cad) === 0;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-bold">Investments</h2>
            <p className="text-sm text-muted-foreground">
              {data
                ? `Portfolio · ${data.base_currency}`
                : "Portfolio tracker"}
            </p>
          </div>
        </div>

        {isLoading && <LoadingBox />}
        {isError && (
          <p className="text-destructive">
            Failed to load portfolio:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        )}

        {!isLoading && isEmpty && <EmptyState />}

        {data && !isEmpty && (
          <section>
            <FundsVsStocksSection data={data} />
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="space-y-3 p-6 text-center">
        <h3 className="text-lg font-semibold">No investments yet</h3>
        <p className="text-sm text-muted-foreground">
          Tag a bank account as <em>Investing — fund</em> to track balances,
          or record a stock purchase to start a self-managed portfolio.
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

function FundsVsStocksSection({ data }: { data: FundsVsStocksResponse }) {
  const fundsPct = num(data.funds_pct);
  const stocksPct = num(data.stocks_pct);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Funds vs Stocks</h3>
        <p className="text-xs text-muted-foreground">
          Total invested: {fmtCAD(data.total_cad)}
        </p>
      </div>

      <div className="mb-4 overflow-hidden rounded-md border bg-muted/30">
        <div
          className="flex h-6 w-full text-xs font-medium"
          role="img"
          aria-label={`${fundsPct.toFixed(0)}% funds, ${stocksPct.toFixed(0)}% stocks`}
        >
          {fundsPct > 0 && (
            <div
              className="flex items-center justify-center bg-sky-500/80 text-white"
              style={{ width: `${fundsPct}%` }}
            >
              {fundsPct >= 8 ? `Funds ${fundsPct.toFixed(1)}%` : ""}
            </div>
          )}
          {stocksPct > 0 && (
            <div
              className="flex items-center justify-center bg-emerald-500/80 text-white"
              style={{ width: `${stocksPct}%` }}
            >
              {stocksPct >= 8 ? `Stocks ${stocksPct.toFixed(1)}%` : ""}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BucketCard row={data.funds} />
        <BucketCard row={data.stocks} />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Funds are tracked by balance only — no per-contribution history,
        so unrealised P&amp;L isn't available. Stocks are valued live via
        the Twelve Data quote cache.
      </p>
    </>
  );
}

function BucketCard({ row }: { row: FundsVsStocksRow }) {
  const isStocks = row.bucket === "stocks";
  const accent = isStocks ? "border-l-emerald-500" : "border-l-sky-500";
  const title = isStocks ? "Stocks" : "Funds";
  const subtitle = isStocks
    ? "Self-managed equity positions"
    : "Bank- or advisor-managed balances";
  const unreal = num(row.unrealized_cad);
  return (
    <Card className={cn("border-l-4", accent)}>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between">
          <h4 className="text-base font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>

        <p className="mt-3 text-2xl font-bold tabular-nums">
          {fmtCAD(row.current_value_cad)}
        </p>

        <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Accounts</dt>
          <dd className="text-right tabular-nums">{row.accounts_count}</dd>

          {isStocks && (
            <>
              <dt className="text-muted-foreground">Holdings</dt>
              <dd className="text-right tabular-nums">{row.holdings_count}</dd>

              <dt className="text-muted-foreground">Cost basis</dt>
              <dd className="text-right tabular-nums">
                {row.cost_basis_cad === null
                  ? "—"
                  : fmtCAD(row.cost_basis_cad)}
              </dd>

              <dt className="text-muted-foreground">Unrealised</dt>
              <dd
                className={cn(
                  "text-right font-semibold tabular-nums",
                  row.unrealized_cad === null
                    ? ""
                    : unreal > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : unreal < 0
                        ? "text-red-600 dark:text-red-400"
                        : "",
                )}
              >
                {row.unrealized_cad === null
                  ? "—"
                  : `${unreal > 0 ? "+" : ""}${fmtCADPrecise(row.unrealized_cad)}`}
              </dd>

              <dt className="text-muted-foreground">Unrealised %</dt>
              <dd
                className={cn(
                  "text-right font-semibold tabular-nums",
                  row.unrealized_pct === null
                    ? ""
                    : num(row.unrealized_pct) > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : num(row.unrealized_pct) < 0
                        ? "text-red-600 dark:text-red-400"
                        : "",
                )}
              >
                {row.unrealized_pct === null
                  ? "—"
                  : fmtPct(row.unrealized_pct)}
              </dd>
            </>
          )}

          {!isStocks && row.stale_days !== null && (
            <>
              <dt className="text-muted-foreground">Oldest balance</dt>
              <dd
                className={cn(
                  "text-right tabular-nums",
                  row.stale_days > 30
                    ? "text-amber-600 dark:text-amber-400"
                    : "",
                )}
              >
                {row.stale_days === 0
                  ? "Today"
                  : `${row.stale_days}d ago`}
              </dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
