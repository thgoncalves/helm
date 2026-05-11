/**
 * Transfers landing page (Company → Personal).
 *
 * Matches Image #28:
 *   Header: "Company → Personal Transfers" + "New Transfer" button.
 *   Fiscal-year preset dropdown (FY YYYY/YYYY+1, default = current FY).
 *   Two card groups:
 *     Transfers      — Total Transferred · Transactions (count)
 *     Tax Estimates  — Est. Company Tax · Est. Personal Tax · Tax Exposure
 *   Search input.
 *   Table: Date · Amount · Category · Method · Est. Company Tax · Est. Personal Tax.
 *   Click a row → navigate to /transfers/:id (Delete lives on the edit form).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import type {
  TransferRead,
  TransferSummary,
} from "@/types/api";
import {
  fiscalYearEnd,
  fiscalYearForDate,
  fiscalYearStart,
  formatCAD,
  num,
  toIsoDate,
} from "@/lib/invoice";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SignOutButton } from "@/components/SignOutButton";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

function fyLabel(fyStartYear: number): string {
  return `FY ${fyStartYear}/${fyStartYear + 1}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function Transfers() {
  const navigate = useNavigate();
  const today = useMemo(() => new Date(), []);
  const currentFy = useMemo(() => fiscalYearForDate(today), [today]);
  // Show "All" + 7 most recent fiscal years.
  const fyOptions = useMemo(() => {
    const out: number[] = [];
    for (let y = currentFy; y >= currentFy - 6; y--) out.push(y);
    return out;
  }, [currentFy]);

  // "all" or a fiscal-year start year.
  const [fy, setFy] = useState<string>(String(currentFy));
  const [search, setSearch] = useState("");

  const range = useMemo(() => {
    if (fy === "all") return { from: null, to: null };
    const start = Number(fy);
    return {
      from: toIsoDate(fiscalYearStart(start)),
      to: toIsoDate(fiscalYearEnd(start)),
    };
  }, [fy]);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
    return p.toString();
  }, [range]);

  const { data: summary } = useQuery<TransferSummary>({
    queryKey: ["transfers-summary", qs],
    queryFn: () =>
      apiFetch<TransferSummary>(
        `/business/transfers/summary${qs ? `?${qs}` : ""}`,
      ),
  });

  const {
    data: transfers,
    isLoading,
    isError,
    error,
  } = useQuery<TransferRead[]>({
    queryKey: ["transfers", qs],
    queryFn: () =>
      apiFetch<TransferRead[]>(
        `/business/transfers/${qs ? `?${qs}` : ""}`,
      ),
  });

  const filtered = useMemo(() => {
    let rows = transfers ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (t) =>
          (t.category ?? "").toLowerCase().includes(q) ||
          (t.method ?? "").toLowerCase().includes(q) ||
          (t.purpose ?? "").toLowerCase().includes(q) ||
          (t.notes ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [transfers, search]);


  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-semibold">Helm</h1>
            <nav className="flex gap-4 text-sm">
              <Link
                to="/clients"
                className="text-muted-foreground hover:text-foreground"
              >
                Clients
              </Link>
              <Link
                to="/timesheets"
                className="text-muted-foreground hover:text-foreground"
              >
                Timesheets
              </Link>
              <Link
                to="/invoices"
                className="text-muted-foreground hover:text-foreground"
              >
                Invoices
              </Link>
              <Link
                to="/payments"
                className="text-muted-foreground hover:text-foreground"
              >
                Payments
              </Link>
              <Link
                to="/taxes"
                className="text-muted-foreground hover:text-foreground"
              >
                Taxes
              </Link>
              <Link to="/transfers" className="font-medium">
                Transfers
              </Link>
              <Link
                to="/settings"
                className="text-muted-foreground hover:text-foreground"
              >
                Settings
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">
            Company → Personal Transfers
          </h2>
          <Button
            className="bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => navigate("/transfers/new")}
          >
            New Transfer
          </Button>
        </div>

        {/* Fiscal-year filter */}
        <div className="mb-4 flex items-center gap-3 rounded-md border bg-card px-4 py-3 text-sm">
          <label htmlFor="fy">Fiscal Year:</label>
          <select
            id="fy"
            aria-label="Fiscal year filter"
            value={fy}
            className={`${SELECT_CLASSES} w-44`}
            onChange={(e) => setFy(e.target.value)}
          >
            <option value="all">All</option>
            {fyOptions.map((y) => (
              <option key={y} value={y}>
                {fyLabel(y)}
              </option>
            ))}
          </select>
        </div>

        {/* KPI cards */}
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Transfers</h3>
              <div className="grid grid-cols-2 gap-3">
                <Kpi
                  label="Total Transferred"
                  value={formatCAD(num(summary?.total_transferred))}
                />
                <Kpi
                  label="Transactions"
                  value={String(summary?.transaction_count ?? 0)}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Tax Estimates</h3>
              <div className="grid grid-cols-3 gap-3">
                <Kpi
                  label="Est. Company Tax"
                  value={formatCAD(num(summary?.est_company_tax))}
                />
                <Kpi
                  label="Est. Personal Tax"
                  value={formatCAD(num(summary?.est_personal_tax))}
                />
                <Kpi
                  label="Tax Exposure"
                  value={formatCAD(num(summary?.tax_exposure))}
                  valueClass="text-amber-600"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search transfers"
          />
          <Button
            variant="outline"
            onClick={() => setSearch("")}
            disabled={!search}
          >
            Clear
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading && (
              <p className="p-6 text-muted-foreground">Loading transfers…</p>
            )}
            {isError && (
              <p className="p-6 text-destructive">
                Failed to load transfers:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}
            {!isLoading && !isError && filtered.length === 0 && (
              <p className="p-6 text-muted-foreground">No transfers found.</p>
            )}
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Amount
                      </th>
                      <th className="px-4 py-2 font-semibold">Category</th>
                      <th className="px-4 py-2 font-semibold">Method</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Est. Company Tax
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Est. Personal Tax
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => {
                      return (
                        <tr
                          key={t.id}
                          className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                          onClick={() => navigate(`/transfers/${t.id}`)}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {formatDate(t.transfer_date)}
                          </td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {formatCAD(num(t.amount))}
                          </td>
                          <td className="px-4 py-2">{t.category ?? "—"}</td>
                          <td className="px-4 py-2">{t.method ?? "—"}</td>
                          <td className="px-4 py-2 text-right">
                            {formatCAD(num(t.estimated_tax_company))}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {formatCAD(num(t.estimated_tax_personal))}
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

      </main>
    </div>
  );
}

function Kpi({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}
