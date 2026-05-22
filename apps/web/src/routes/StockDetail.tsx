/**
 * StockDetail — single-ticker view with chart + your positions + lots.
 *
 * Route: /investments/stocks/:ticker
 *
 * Single GET /investments/stocks/{ticker} fetches everything: quote
 * (price + delta), 1Y history for the chart, your positions in that
 * stock (one row per account), and your buy transactions. Recharts
 * draws the line chart against the daily-close series.
 *
 * The "Record purchase" button jumps to /investments/stocks/buy with
 * the ticker pre-filled as a query param.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch } from "@/lib/api";
import type { StockDetailResponse } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

function fmtPct(v: number | string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = num(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function StockDetail() {
  const navigate = useNavigate();
  const { ticker = "" } = useParams<{ ticker: string }>();
  const symbol = ticker.toUpperCase();

  const { data, isLoading, isError, error } = useQuery<StockDetailResponse>({
    queryKey: ["stock", symbol],
    queryFn: () =>
      apiFetch<StockDetailResponse>(
        `/investments/stocks/${encodeURIComponent(symbol)}`,
      ),
    enabled: Boolean(symbol),
  });

  const chart = useMemo(() => {
    return (data?.history ?? []).map((p) => ({
      date: p.date,
      close: num(p.close),
    }));
  }, [data?.history]);

  const delta = useMemo(() => {
    if (!data) return null;
    const last = num(data.quote.last_price);
    const prev = num(data.quote.previous_close);
    if (!prev) return null;
    const abs = last - prev;
    const pct = (abs / prev) * 100;
    return { abs, pct };
  }, [data]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4">
        <Link
          to="/investments/stocks"
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          ← Back to Stocks
        </Link>
      </div>

      {isLoading && <LoadingBox />}
      {isError && (
        <p className="text-destructive">
          Failed to load: {error instanceof Error ? error.message : "Unknown"}
        </p>
      )}

      {data && (
        <>
          {/* Quote header */}
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold">
                {data.quote.name ?? symbol}
              </h2>
              <p className="text-sm text-muted-foreground">
                {data.quote.exchange ?? "—"}: {data.quote.ticker}
              </p>
            </div>
            <Button
              onClick={() =>
                navigate(
                  `/investments/stocks/buy?ticker=${encodeURIComponent(symbol)}`,
                )
              }
            >
              Record purchase
            </Button>
          </div>

          <Card className="mb-6">
            <CardContent className="p-6">
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold tabular-nums">
                  {fmtMoney(data.quote.last_price, data.quote.currency)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {data.quote.currency}
                </span>
              </div>
              {delta && (
                <p
                  className={
                    "mt-1 text-sm font-medium " +
                    (delta.abs >= 0 ? "text-emerald-700" : "text-red-700")
                  }
                >
                  {delta.abs >= 0 ? "▲" : "▼"}{" "}
                  {fmtMoney(Math.abs(delta.abs), data.quote.currency)} (
                  {fmtPct(delta.pct)}) since previous close
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Updated {new Date(data.quote.fetched_at).toLocaleString("en-CA")}
              </p>

              {/* Chart */}
              <div className="mt-6 h-64 w-full">
                {chart.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No price history available.
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        opacity={0.2}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v: string) =>
                          v.slice(0, 7) // YYYY-MM
                        }
                        minTickGap={40}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        domain={["auto", "auto"]}
                        width={60}
                        tickFormatter={(v: number) => v.toFixed(0)}
                      />
                      <Tooltip
                        formatter={(value: unknown) =>
                          fmtMoney(num(value as number), data.quote.currency)
                        }
                        labelFormatter={(v: unknown) =>
                          typeof v === "string" ? fmtDate(v) : ""
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="close"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Positions */}
          <h3 className="mb-3 text-lg font-semibold">
            Your position in {symbol}
          </h3>
          <Card className="mb-6">
            <CardContent className="p-0">
              {data.positions.length === 0 ? (
                <p className="p-6 text-muted-foreground">
                  You don't hold {symbol} yet. Click "Record purchase"
                  above to add your first lot.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-4 py-2 font-semibold">Account</th>
                        <th className="px-4 py-2 text-right font-semibold">
                          Shares
                        </th>
                        <th className="px-4 py-2 text-right font-semibold">
                          ACB / share
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
                      {data.positions.map((p) => {
                        const u = num(p.unrealized);
                        return (
                          <tr
                            key={p.account_id}
                            className="border-b last:border-0"
                          >
                            <td className="px-4 py-2">{p.account_name}</td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {num(p.quantity)
                                .toFixed(4)
                                .replace(/\.?0+$/, "")}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {fmtMoney(p.acb_per_share, p.currency)}
                            </td>
                            <td className="px-4 py-2 text-right font-semibold tabular-nums">
                              {fmtMoney(p.current_value, p.currency)}
                            </td>
                            <td
                              className={
                                "px-4 py-2 text-right font-semibold tabular-nums " +
                                (u > 0
                                  ? "text-emerald-700"
                                  : u < 0
                                    ? "text-red-700"
                                    : "")
                              }
                            >
                              {u === 0
                                ? "—"
                                : `${u > 0 ? "+" : ""}${fmtMoney(p.unrealized, p.currency)} (${fmtPct(p.unrealized_pct)})`}
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

          {/* Transactions */}
          <h3 className="mb-3 text-lg font-semibold">Transactions</h3>
          <Card>
            <CardContent className="p-0">
              {data.transactions.length === 0 ? (
                <p className="p-6 text-muted-foreground">
                  No transactions yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-4 py-2 font-semibold">Date</th>
                        <th className="px-4 py-2 font-semibold">Type</th>
                        <th className="px-4 py-2 text-right font-semibold">
                          Quantity
                        </th>
                        <th className="px-4 py-2 text-right font-semibold">
                          Unit price
                        </th>
                        <th className="px-4 py-2 text-right font-semibold">
                          Fees
                        </th>
                        <th className="px-4 py-2 font-semibold">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.transactions.map((t) => (
                        <tr
                          key={t.id}
                          className="border-b last:border-0"
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {fmtDate(t.transaction_date)}
                          </td>
                          <td className="px-4 py-2 capitalize">
                            {t.transaction_type}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {num(t.quantity)
                              .toFixed(4)
                              .replace(/\.?0+$/, "")}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {fmtMoney(t.unit_price, t.currency)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {fmtMoney(t.fees, t.currency)}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {t.notes ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>

  );
}
