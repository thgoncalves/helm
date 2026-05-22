/**
 * Stocks landing page — search + your current positions.
 *
 * The search box hits /investments/stocks/search?q=… (Yahoo proxy);
 * selecting a hit navigates to /investments/stocks/:ticker for the
 * detail page. The "Your Positions" table below summarises tickers
 * you already hold — pulled from /investments/portfolio so it's
 * always in sync with the portfolio surface, just filtered to equity
 * (asset_class='equity') rows that have stock transactions.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  StockPortfolioRow,
  StockSearchHit,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoadingBox } from "@/components/LoadingScreen";

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

function fmtMoney(v: number | string | null, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(num(v));
}

export function Stocks() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounce the search so we don't fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searchQ = useQuery<StockSearchHit[]>({
    queryKey: ["stocks-search", debounced],
    queryFn: () =>
      apiFetch<StockSearchHit[]>(
        `/investments/stocks/search?q=${encodeURIComponent(debounced)}`,
      ),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  });

  const positionsQ = useQuery<StockPortfolioRow[]>({
    queryKey: ["stock-positions"],
    queryFn: () =>
      apiFetch<StockPortfolioRow[]>("/investments/stocks/positions"),
  });

  const positions = positionsQ.data ?? [];

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6">
          <h2 className="text-2xl font-bold">Stocks</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Self-managed equity tracking. Search a ticker to see its
            chart and recent price; record buys to build your portfolio.
          </p>
        </header>

        {/* Search */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <label
              htmlFor="ticker-search"
              className="mb-2 block text-sm font-medium"
            >
              Search by symbol or company name
            </label>
            <div className="flex gap-2">
              <Input
                id="ticker-search"
                autoFocus
                placeholder="e.g. AAPL, Apple, RY.TO"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && query.trim()) {
                    navigate(
                      `/investments/stocks/${encodeURIComponent(query.trim().toUpperCase())}`,
                    );
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!query.trim()}
                onClick={() =>
                  navigate(
                    `/investments/stocks/${encodeURIComponent(query.trim().toUpperCase())}`,
                  )
                }
              >
                Go
              </Button>
            </div>

            {debounced.length > 0 && (
              <div className="mt-3">
                {searchQ.isLoading ? (
                  <LoadingBox />
                ) : searchQ.isError ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    <p className="font-medium text-amber-900 dark:text-amber-200">
                      {searchQ.error instanceof ApiError &&
                      searchQ.error.status === 503
                        ? "Yahoo Finance is rate-limiting us."
                        : "Search failed."}
                    </p>
                    <p className="mt-1 text-amber-800 dark:text-amber-300/80">
                      You can still type the exact ticker (e.g.{" "}
                      <code>AAPL</code>) and click <strong>Go</strong> to
                      open its page directly.
                    </p>
                  </div>
                ) : (searchQ.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No matches. Click <strong>Go</strong> to open
                    "{query.toUpperCase()}" directly if you know it's a
                    valid ticker.
                  </p>
                ) : (
                  <ul className="divide-y rounded-md border bg-card">
                    {(searchQ.data ?? []).map((hit) => (
                      <li key={hit.ticker}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent/40"
                          onClick={() =>
                            navigate(
                              `/investments/stocks/${encodeURIComponent(hit.ticker)}`,
                            )
                          }
                        >
                          <span className="font-mono text-sm font-semibold">
                            {hit.ticker}
                          </span>
                          <span className="ml-3 flex-1 truncate text-sm text-muted-foreground">
                            {hit.name ?? "—"}
                          </span>
                          <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                            {hit.exchange ?? ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Your positions */}
        <h3 className="mb-3 text-lg font-semibold">Your positions</h3>
        <Card>
          <CardContent className="p-0">
            {positionsQ.isLoading ? (
              <div className="p-4">
                <LoadingBox />
              </div>
            ) : positions.length === 0 ? (
              <p className="p-6 text-muted-foreground">
                You don't have any stock positions yet. Search above
                and click a ticker to record your first buy.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Ticker</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Shares
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Accounts
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Current value
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Unrealized
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const unreal = num(p.unrealized);
                      return (
                        <tr
                          key={p.ticker}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                          onClick={() =>
                            navigate(
                              `/investments/stocks/${encodeURIComponent(p.ticker)}`,
                            )
                          }
                        >
                          <td className="px-4 py-2 font-mono font-semibold">
                            {p.ticker}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {num(p.shares).toFixed(4).replace(/\.?0+$/, "")}
                          </td>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                            {p.accounts}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {p.current_value === null
                              ? "—"
                              : fmtMoney(p.current_value, p.currency)}
                          </td>
                          <td
                            className={
                              "px-4 py-2 text-right font-semibold " +
                              (unreal > 0
                                ? "text-emerald-700"
                                : unreal < 0
                                  ? "text-red-700"
                                  : "")
                            }
                          >
                            {p.unrealized === null
                              ? "—"
                              : unreal === 0
                                ? "—"
                                : `${unreal > 0 ? "+" : ""}${fmtMoney(p.unrealized, p.currency)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-xs text-muted-foreground">
          Prices via Yahoo Finance, cached for 15 minutes. Selling and
          tax-time capital gains are planned for V1.5 — see{" "}
          <code>docs/specs/investments-stocks-tax-v1.md</code>.
        </p>
      </main>
    </div>
  );
}
