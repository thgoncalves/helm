/**
 * Research — curated universe browser.
 *
 * Loads the seeded research_tickers from /investments/research with
 * cached quote + your position (if any). Each row links to the
 * existing /investments/stocks/:ticker page for the chart + buy
 * form.
 *
 * Prices are on-demand: rows without a cached quote show "Click ↻";
 * older than 24h shows the stale-day count next to the price. The
 * refresh button calls POST /investments/research/refresh/:ticker.
 *
 * Spec: docs/specs/investments-research-v1.md.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type { ResearchRow } from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingBox } from "@/components/LoadingScreen";
import { cn } from "@/lib/utils";

type SortKey = "ticker" | "name" | "sector" | "day_change_pct" | "position";

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

function fmtSharesCompact(shares: number | string): string {
  const n = num(shares);
  return n.toFixed(4).replace(/\.?0+$/, "");
}

function fmtAge(fetchedAt: string | null): string {
  if (!fetchedAt) return "Click ↻";
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  const hours = Math.floor(ageMs / 36e5);
  if (hours < 24) return ""; // fresh enough — no annotation
  const days = Math.floor(hours / 24);
  return `Stale · ${days}d`;
}

function countryFlag(c: "US" | "CA"): string {
  return c === "US" ? "🇺🇸" : "🇨🇦";
}

export function Research() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sector, setSector] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("ticker");
  const [refreshingTicker, setRefreshingTicker] = useState<string | null>(null);

  const listQ = useQuery<ResearchRow[]>({
    queryKey: ["research"],
    queryFn: () => apiFetch<ResearchRow[]>("/investments/research"),
  });

  const refreshMut = useMutation<ResearchRow, ApiError, string>({
    mutationFn: (ticker) =>
      apiFetch<ResearchRow>(
        `/investments/research/refresh/${encodeURIComponent(ticker)}`,
        { method: "POST" },
      ),
    onMutate: (ticker) => setRefreshingTicker(ticker),
    onSettled: () => setRefreshingTicker(null),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["research"] }),
  });

  const rows = listQ.data ?? [];

  // Sectors dropdown — derive from the data so adding new tickers
  // doesn't require a UI change.
  const sectors = useMemo(() => {
    const set = new Set<string>(rows.map((r) => r.sector));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const visible = useMemo(() => {
    const filtered =
      sector === "all" ? rows : rows.filter((r) => r.sector === sector);
    const sorted = [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "ticker":
          return a.ticker.localeCompare(b.ticker);
        case "name":
          return a.name.localeCompare(b.name);
        case "sector":
          return (
            a.sector.localeCompare(b.sector) || a.ticker.localeCompare(b.ticker)
          );
        case "day_change_pct":
          return num(b.day_change_pct) - num(a.day_change_pct);
        case "position":
          return num(b.position_value_cad) - num(a.position_value_cad);
        default:
          return 0;
      }
    });
    return sorted;
  }, [rows, sector, sortKey]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6">
          <h2 className="text-2xl font-bold">Research</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse a curated universe of {rows.length || "—"} tickers. Click ↻
            to load or refresh a price; click a row to see the chart + buy
            form.
          </p>
        </header>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Sector</span>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s === "all" ? "All sectors" : s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Sort by</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value="ticker">Ticker</option>
              <option value="name">Name</option>
              <option value="sector">Sector</option>
              <option value="day_change_pct">Day Δ</option>
              <option value="position">Position value</option>
            </select>
          </label>
        </div>

        <Card>
          <CardContent className="p-0">
            {listQ.isLoading ? (
              <div className="p-4">
                <LoadingBox />
              </div>
            ) : listQ.isError ? (
              <p className="p-6 text-destructive">
                Failed to load research universe:{" "}
                {listQ.error instanceof Error
                  ? listQ.error.message
                  : "Unknown error"}
              </p>
            ) : visible.length === 0 ? (
              <p className="p-6 text-muted-foreground">
                No tickers match this filter.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-3 py-2 font-semibold">Ticker</th>
                      <th className="px-3 py-2 font-semibold">Name</th>
                      <th className="px-3 py-2 font-semibold">Sector</th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Price
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Day Δ
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        Position
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        {/* refresh */}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <ResearchTableRow
                        key={r.ticker}
                        row={r}
                        refreshing={refreshingTicker === r.ticker}
                        onRefresh={() => refreshMut.mutate(r.ticker)}
                        onOpen={() =>
                          navigate(
                            `/investments/stocks/${encodeURIComponent(r.ticker)}`,
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-xs text-muted-foreground">
          Prices via Twelve Data, cached for 24h on this view. Fundamentals
          (P/E, dividend yield, market cap, 52w hi/lo) are deferred — see{" "}
          <code>docs/specs/investments-research-v1.md</code>.
        </p>
      </main>
    </div>
  );
}

function ResearchTableRow({
  row,
  refreshing,
  onRefresh,
  onOpen,
}: {
  row: ResearchRow;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: () => void;
}) {
  const dayChange = row.day_change_pct === null ? null : num(row.day_change_pct);
  const dayClass =
    dayChange === null
      ? "text-muted-foreground"
      : dayChange > 0
        ? "text-emerald-700 dark:text-emerald-400"
        : dayChange < 0
          ? "text-red-700 dark:text-red-400"
          : "text-muted-foreground";
  const dayGlyph =
    dayChange === null ? "—" : dayChange > 0 ? "▲" : dayChange < 0 ? "▼" : "—";
  const dayLabel =
    dayChange === null
      ? ""
      : `${dayGlyph} ${dayChange > 0 ? "+" : ""}${dayChange.toFixed(2)}%`;

  const priceCurrency = row.currency ?? "USD";
  const isCad = priceCurrency.toUpperCase() === "CAD";
  const ageLabel = fmtAge(row.fetched_at);
  const shares = num(row.position_shares);
  const hasPosition = shares > 0;

  return (
    <tr
      className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
      onClick={onOpen}
    >
      <td className="px-3 py-2 font-mono font-semibold">
        <span className="mr-1.5">{countryFlag(row.country)}</span>
        {row.ticker}
      </td>
      <td className="max-w-[18ch] truncate px-3 py-2">{row.name}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {row.sector}
      </td>
      <td className="px-3 py-2 text-right">
        {row.last_price === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <>
            <div className="font-semibold">
              {fmtMoney(row.last_price, priceCurrency)}
            </div>
            {!isCad && row.position_value_cad === null && (
              <div className="text-xs text-muted-foreground">
                {priceCurrency}
              </div>
            )}
            {ageLabel && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {ageLabel}
              </div>
            )}
          </>
        )}
      </td>
      <td className={cn("px-3 py-2 text-right font-semibold", dayClass)}>
        {dayLabel || "—"}
      </td>
      <td className="px-3 py-2 text-right">
        {hasPosition ? (
          <>
            <div className="font-semibold">{fmtSharesCompact(shares)} sh</div>
            <div className="text-xs text-muted-foreground">
              {row.position_value_cad !== null
                ? fmtMoney(row.position_value_cad, "CAD")
                : row.position_value_native !== null
                  ? `${fmtMoney(row.position_value_native, priceCurrency)} (FX unavailable)`
                  : "—"}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={onRefresh}
          aria-label={`Refresh ${row.ticker}`}
        >
          {refreshing ? "…" : "↻"}
        </Button>
      </td>
    </tr>
  );
}
