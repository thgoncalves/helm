/**
 * RecordPurchase — record a stock buy lot.
 *
 * Route: /investments/stocks/buy?ticker=AAPL
 *
 * The account dropdown is fed by `GET /investments/stocks/accounts`,
 * which unifies manual_accounts and ynab_accounts filtered to
 * ``helm_kind='investing_stock'``. The selected account carries a
 * ``supports_cash_debit`` flag — YNAB-sourced accounts have it off
 * because the YNAB sync owns those balances, so we never write back
 * to YNAB. Manual accounts get the auto-debit toggle.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  StockAccountRow,
  StockQuoteRead,
  StockTransactionCreate,
  StockTransactionRead,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingBox } from "@/components/LoadingScreen";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

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

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function accountKey(a: StockAccountRow): string {
  return `${a.source}:${a.id}`;
}

function sourceLabel(source: StockAccountRow["source"]): string {
  switch (source) {
    case "manual":
      return "Manual";
    case "ynab":
      return "YNAB";
  }
}

export function RecordPurchase() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialTicker = (searchParams.get("ticker") ?? "").toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [date, setDate] = useState<string>(todayIso());
  const [quantity, setQuantity] = useState<string>("");
  const [unitPrice, setUnitPrice] = useState<string>("");
  const [fees, setFees] = useState<string>("0");
  const [notes, setNotes] = useState<string>("");
  const [autoDebit, setAutoDebit] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const accountsQ = useQuery<StockAccountRow[]>({
    queryKey: ["stock-accounts"],
    queryFn: () =>
      apiFetch<StockAccountRow[]>("/investments/stocks/accounts"),
    staleTime: 60_000,
  });

  const accounts = accountsQ.data ?? [];

  useEffect(() => {
    if (!selectedKey && accounts.length > 0) {
      const first = accounts[0];
      if (first) setSelectedKey(accountKey(first));
    }
  }, [accounts, selectedKey]);

  const selected = accounts.find((a) => accountKey(a) === selectedKey);

  // For YNAB sources we hide the toggle entirely — YNAB owns the balance.
  useEffect(() => {
    if (selected && !selected.supports_cash_debit && autoDebit) {
      setAutoDebit(false);
    }
  }, [selected, autoDebit]);

  const quoteQ = useQuery<StockQuoteRead>({
    queryKey: ["stock-quote", ticker],
    queryFn: () =>
      apiFetch<StockQuoteRead>(
        `/investments/stocks/refresh-quote/${encodeURIComponent(ticker)}`,
        { method: "POST" },
      ),
    enabled: Boolean(ticker),
    retry: false,
  });

  useEffect(() => {
    if (quoteQ.data && unitPrice === "") {
      setUnitPrice(String(quoteQ.data.last_price));
    }
  }, [quoteQ.data, unitPrice]);

  const currency =
    quoteQ.data?.currency ?? selected?.currency ?? "USD";

  const cost = useMemo(
    () => num(quantity) * num(unitPrice) + num(fees),
    [quantity, unitPrice, fees],
  );

  const projectedCash = useMemo(() => {
    if (!selected) return null;
    if (!autoDebit || !selected.supports_cash_debit) {
      return num(selected.cash_balance);
    }
    return num(selected.cash_balance) - cost;
  }, [selected, autoDebit, cost]);

  const saveMutation = useMutation<StockTransactionRead, ApiError, void>({
    mutationFn: async () => {
      if (!selected) throw new Error("No account selected");
      const body: StockTransactionCreate = {
        account_source: selected.source,
        account_id: selected.id,
        ticker: ticker.toUpperCase(),
        transaction_date: date,
        quantity,
        unit_price: unitPrice,
        fees,
        currency,
        notes: notes || null,
        transaction_type: "buy",
        auto_debit_cash: autoDebit && selected.supports_cash_debit,
      };
      return apiFetch<StockTransactionRead>(
        "/investments/stocks/transactions",
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["stock", ticker.toUpperCase()],
      });
      void queryClient.invalidateQueries({ queryKey: ["stock-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["investment-accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["stock-accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      navigate(
        `/investments/stocks/${encodeURIComponent(ticker.toUpperCase())}`,
      );
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : err instanceof Error
            ? err.message
            : "Unknown error";
      setError(msg);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError("Pick an account first.");
      return;
    }
    if (!ticker.trim()) {
      setError("Enter a ticker.");
      return;
    }
    if (num(quantity) <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }
    if (num(unitPrice) < 0) {
      setError("Unit price can't be negative.");
      return;
    }
    saveMutation.mutate();
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-2xl px-4 py-6">
        <h2 className="mb-1 text-2xl font-bold">Record purchase</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          Add a buy lot. Cost basis (ACB) is recomputed automatically.
        </p>

        {accountsQ.isLoading ? (
          <LoadingBox />
        ) : accounts.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm">
              <p className="mb-2 font-medium">
                No "Stocks" accounts tagged yet.
              </p>
              <p className="text-muted-foreground">
                On the Accounts page, tag one of your accounts with kind
                "Investing — Stocks". YNAB-synced brokerage cash
                accounts, manual cash accounts, and Helm-native
                investment accounts all qualify.
              </p>
            </CardContent>
          </Card>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Card>
              <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[180px_1fr] sm:items-center">
                <Label htmlFor="ticker">
                  Ticker <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ticker"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="e.g. AAPL, RY.TO"
                  required
                />

                <Label htmlFor="account">
                  Account <span className="text-destructive">*</span>
                </Label>
                <select
                  id="account"
                  className={SELECT_CLASSES}
                  value={selectedKey}
                  onChange={(e) => setSelectedKey(e.target.value)}
                  required
                >
                  {accounts.map((a) => (
                    <option key={accountKey(a)} value={accountKey(a)}>
                      {a.name} · {sourceLabel(a.source)} ·{" "}
                      {fmtMoney(a.cash_balance, a.currency)}
                    </option>
                  ))}
                </select>

                <Label htmlFor="date">
                  Date <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />

                <Label htmlFor="quantity">
                  Quantity <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="quantity"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                />

                <Label htmlFor="unit_price">
                  Unit price ({currency}){" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="unit_price"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  required
                />

                <Label htmlFor="fees">Fees ({currency})</Label>
                <Input
                  id="fees"
                  type="number"
                  step="0.01"
                  min="0"
                  value={fees}
                  onChange={(e) => setFees(e.target.value)}
                />

                <Label htmlFor="notes">Notes</Label>
                <Input
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional"
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                {selected?.supports_cash_debit ? (
                  <>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={autoDebit}
                        onChange={(e) => setAutoDebit(e.target.checked)}
                      />
                      <span className="text-sm">
                        <span className="font-medium">
                          Debit the account's cash balance
                        </span>
                        <br />
                        <span className="text-muted-foreground">
                          Subtracts total cost (quantity × price + fees) from
                          your cash on hand. Turn off if you moved the cash
                          externally.
                        </span>
                      </span>
                    </label>
                  </>
                ) : (
                  <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm">
                    <p className="font-medium">
                      This is a YNAB-synced account.
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Helm won't debit the cash balance here — record the
                      buy in YNAB too (transfer cash → stock holding) and
                      the next YNAB sync will pick up the new balance.
                    </p>
                  </div>
                )}

                <div className="mt-4 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total cost</span>
                    <span className="font-semibold tabular-nums">
                      {fmtMoney(cost, currency)}
                    </span>
                  </div>
                  {selected && (
                    <>
                      <div className="mt-1 flex justify-between">
                        <span className="text-muted-foreground">
                          Cash before
                        </span>
                        <span className="tabular-nums">
                          {fmtMoney(selected.cash_balance, selected.currency)}
                        </span>
                      </div>
                      <div className="mt-1 flex justify-between">
                        <span className="text-muted-foreground">
                          Cash after
                        </span>
                        <span
                          className={
                            "font-semibold tabular-nums " +
                            (projectedCash !== null && projectedCash < 0
                              ? "text-amber-700"
                              : "")
                          }
                        >
                          {fmtMoney(projectedCash, selected.currency)}
                        </span>
                      </div>
                      {projectedCash !== null &&
                        projectedCash < 0 &&
                        selected.supports_cash_debit && (
                          <p className="mt-2 text-xs text-amber-700">
                            Heads up — this buy would put cash below zero.
                            Allowed, but you may want to top up first or
                            uncheck the toggle if the cash moved separately.
                          </p>
                        )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(-1)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving…" : "Record buy"}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
