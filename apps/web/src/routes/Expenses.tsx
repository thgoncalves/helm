/**
 * Expenses landing page — receipts / supplier invoices.
 *
 *  Upload flow:
 *   1. Hidden <input type="file" accept="image/*" capture="environment">
 *      — on iPhone, `capture` opens the rear camera directly.
 *   2. On file selected: POST /business/expenses/ → { expense, upload_url }
 *   3. PUT the file directly to S3 using the presigned URL.
 *   4. Server-side: S3 event triggers the processor Lambda → Textract →
 *      UPDATE expenses row to 'ready' or 'failed'.
 *   5. Frontend polls every 3s WHILE any row is still 'pending' or
 *      'processing'. Polling stops once everything settles.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type { ExpenseCreateResponse, ExpenseRead } from "@/types/api";
import {
  fiscalYearEnd,
  fiscalYearForDate,
  fiscalYearStart,
  formatCAD,
  num,
  toIsoDate,
} from "@/lib/invoice";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

type FyPreset = "this" | "last" | "all" | "custom";

function presetRange(
  preset: FyPreset,
  today: Date,
): { from: string | null; to: string | null } {
  if (preset === "all") return { from: null, to: null };
  if (preset === "this") {
    const fy = fiscalYearForDate(today);
    return {
      from: toIsoDate(fiscalYearStart(fy)),
      to: toIsoDate(fiscalYearEnd(fy)),
    };
  }
  if (preset === "last") {
    const fy = fiscalYearForDate(today) - 1;
    return {
      from: toIsoDate(fiscalYearStart(fy)),
      to: toIsoDate(fiscalYearEnd(fy)),
    };
  }
  return { from: null, to: null };
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function StatusBadge({ status }: { status: ExpenseRead["status"] }) {
  const styles: Record<ExpenseRead["status"], string> = {
    pending: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
    processing:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
    ready:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
    failed: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  };
  const labels: Record<ExpenseRead["status"], string> = {
    pending: "Pending",
    processing: "Processing",
    ready: "Ready",
    failed: "Failed",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

export function Expenses() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const today = useMemo(() => new Date(), []);
  const initial = presetRange("this", today);

  const [preset, setPreset] = useState<FyPreset>("this");
  const [from, setFrom] = useState(initial.from ?? "");
  const [to, setTo] = useState(initial.to ?? "");
  const [appliedFrom, setAppliedFrom] = useState(initial.from ?? "");
  const [appliedTo, setAppliedTo] = useState(initial.to ?? "");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const apiQueryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (appliedFrom) qs.set("from", appliedFrom);
    if (appliedTo) qs.set("to", appliedTo);
    if (statusFilter !== "all") qs.set("status", statusFilter);
    return qs.toString();
  }, [appliedFrom, appliedTo, statusFilter]);

  const expensesQuery = useQuery<ExpenseRead[]>({
    queryKey: ["expenses", apiQueryString],
    queryFn: () =>
      apiFetch<ExpenseRead[]>(
        `/business/expenses/${apiQueryString ? `?${apiQueryString}` : ""}`,
      ),
    // Keep polling while any row is still pending/processing so the
    // status flips visible without the user having to refresh. Polling
    // stops once everything settles.
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as ExpenseRead[];
      const inFlight = rows.some(
        (r) => r.status === "pending" || r.status === "processing",
      );
      return inFlight ? 3000 : false;
    },
  });

  const uploadMutation = useMutation<ExpenseRead, ApiError | Error, File>({
    mutationFn: async (file: File) => {
      const dotIdx = file.name.lastIndexOf(".");
      const extension =
        dotIdx >= 0 ? file.name.slice(dotIdx + 1) : "jpg";
      const created = await apiFetch<ExpenseCreateResponse>(
        "/business/expenses/",
        {
          method: "POST",
          body: JSON.stringify({
            file_extension: extension,
            content_type: file.type || "image/jpeg",
            size_bytes: file.size,
          }),
        },
      );
      // Direct upload to S3 via the presigned URL — Lambda's body limit
      // doesn't apply since we never proxy the file through the API.
      const putResponse = await fetch(created.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error(`Upload failed: ${putResponse.status}`);
      }
      return created.expense;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
    onError: (err) => {
      setUploadError(
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : err instanceof Error
            ? err.message
            : "Unknown error",
      );
    },
  });

  function applyPreset(next: FyPreset) {
    setPreset(next);
    const r = presetRange(next, today);
    setFrom(r.from ?? "");
    setTo(r.to ?? "");
    setAppliedFrom(r.from ?? "");
    setAppliedTo(r.to ?? "");
  }

  function applyCustom() {
    setPreset("custom");
    setAppliedFrom(from);
    setAppliedTo(to);
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    const file = event.target.files?.[0];
    // Reset the input so picking the same file twice still triggers.
    if (event.target) event.target.value = "";
    if (!file) return;
    uploadMutation.mutate(file);
  }

  const filtered: ExpenseRead[] = useMemo(() => {
    let rows = expensesQuery.data ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (e) =>
          (e.supplier ?? "").toLowerCase().includes(q) ||
          (e.category ?? "").toLowerCase().includes(q) ||
          (e.notes ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [expensesQuery.data, search]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Title + Upload */}
        <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Expenses</h2>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? "Uploading…" : "New Expense"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            // `capture` is the iPhone trigger to open the rear camera
            // immediately. On desktop it's ignored and the OS file
            // picker opens instead.
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Upload receipt"
          />
        </div>

        {uploadError && (
          <p className="mb-3 text-sm text-destructive">
            Upload failed: {uploadError}
          </p>
        )}

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card px-4 py-3 text-sm">
          <select
            aria-label="Fiscal year preset"
            value={preset}
            className={`${SELECT_CLASSES} w-44`}
            onChange={(e) => applyPreset(e.target.value as FyPreset)}
          >
            <option value="this">This Financial Year</option>
            <option value="last">Last Financial Year</option>
            <option value="all">All</option>
            <option value="custom">Custom</option>
          </select>
          <label className="ml-2">From:</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPreset("custom");
            }}
            className="h-9 w-40"
          />
          <label>To:</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPreset("custom");
            }}
            className="h-9 w-40"
          />
          <Button variant="outline" size="sm" onClick={applyCustom}>
            Apply
          </Button>

          <label className="ml-3">Status:</label>
          <select
            aria-label="Status filter"
            value={statusFilter}
            className={`${SELECT_CLASSES} w-36`}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="ready">Ready</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {/* Search */}
        <div className="mb-3 flex gap-2">
          <Input
            placeholder="Search supplier, category, or notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search expenses"
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
            {expensesQuery.isLoading && (
              <p className="p-6 text-muted-foreground">Loading expenses…</p>
            )}
            {expensesQuery.isError && (
              <p className="p-6 text-destructive">
                Failed to load expenses:{" "}
                {expensesQuery.error instanceof Error
                  ? expensesQuery.error.message
                  : "Unknown error"}
              </p>
            )}
            {!expensesQuery.isLoading &&
              !expensesQuery.isError &&
              filtered.length === 0 && (
                <p className="p-6 text-muted-foreground">
                  No expenses yet. Tap "New Expense" to upload your first
                  receipt.
                </p>
              )}
            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Supplier</th>
                      <th className="px-4 py-2 font-semibold">Category</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Total
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Tax
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => (
                      <tr
                        key={e.id}
                        className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                        onClick={() => navigate(`/expenses/${e.id}`)}
                      >
                        <td className="px-4 py-2">
                          <StatusBadge status={e.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                          {formatDate(e.expense_date)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-medium">
                          {e.supplier ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          {e.category ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right font-semibold">
                          {e.total != null ? formatCAD(num(e.total)) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-muted-foreground">
                          {e.tax_amount != null
                            ? formatCAD(num(e.tax_amount))
                            : "—"}
                        </td>
                      </tr>
                    ))}
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
