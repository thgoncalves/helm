/**
 * ExpenseForm — edit-only screen for a previously-uploaded expense.
 *
 * Layout:
 *   ┌─────────────┬──────────────────────────┐
 *   │             │ Date* / Supplier* /      │
 *   │  image      │ Category / Subtotal /    │
 *   │  preview    │ Tax / Total / Currency / │
 *   │             │ Notes                    │
 *   │             │                          │
 *   └─────────────┴──────────────────────────┘
 *   [Delete]                       [Cancel][Save]
 *
 * The image is loaded via GET /business/expenses/:id/image-url which
 * returns a 5-minute presigned URL. The form fields hydrate from the
 * row and the user can fix anything Textract got wrong.
 *
 * No "create" mode here — new expenses are made from the landing page's
 * photo-upload flow.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  ExpenseImageUrlResponse,
  ExpenseRead,
  ExpenseUpdate,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const CATEGORIES = [
  "Software",
  "Travel",
  "Meals",
  "Office Supplies",
  "Utilities",
  "Professional Services",
  "Hardware",
  "Other",
];

interface FormState {
  expense_date: string;
  supplier: string;
  category: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  currency: string;
  notes: string;
}

function fromExpense(e: ExpenseRead): FormState {
  return {
    expense_date: e.expense_date ?? "",
    supplier: e.supplier ?? "",
    category: e.category ?? "",
    subtotal: e.subtotal != null ? String(e.subtotal) : "",
    tax_amount: e.tax_amount != null ? String(e.tax_amount) : "",
    total: e.total != null ? String(e.total) : "",
    currency: e.currency ?? "CAD",
    notes: e.notes ?? "",
  };
}

export function ExpenseForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const expenseQuery = useQuery<ExpenseRead>({
    queryKey: ["expense", id],
    queryFn: () => apiFetch<ExpenseRead>(`/business/expenses/${id}`),
    enabled: !!id,
    // Poll while still processing so the form re-hydrates with OCR
    // fields once the processor Lambda finishes.
    refetchInterval: (query) => {
      const e = query.state.data as ExpenseRead | undefined;
      if (!e) return false;
      return e.status === "pending" || e.status === "processing"
        ? 2000
        : false;
    },
  });

  const imageUrlQuery = useQuery<ExpenseImageUrlResponse>({
    queryKey: ["expense-image-url", id],
    queryFn: () =>
      apiFetch<ExpenseImageUrlResponse>(
        `/business/expenses/${id}/image-url`,
      ),
    enabled: !!id,
    // Presigned URLs are short-lived (5 min). Refetch periodically.
    staleTime: 4 * 60_000,
  });

  const [state, setState] = useState<FormState>({
    expense_date: "",
    supplier: "",
    category: "",
    subtotal: "",
    tax_amount: "",
    total: "",
    currency: "CAD",
    notes: "",
  });
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  // Hydrate form once we have data (or when OCR completes for a row
  // that was still processing when the user opened the page).
  useEffect(() => {
    if (!expenseQuery.data) return;
    // Only re-hydrate if the row is now `ready`/`failed` (data is stable)
    // OR the user hasn't touched anything yet (initial load).
    const stableStatus = expenseQuery.data.status !== "processing";
    const firstLoad = hydratedFor !== expenseQuery.data.id;
    if (firstLoad || (stableStatus && hydratedFor === expenseQuery.data.id + ":processing")) {
      setState(fromExpense(expenseQuery.data));
      setHydratedFor(
        expenseQuery.data.id +
          (expenseQuery.data.status === "processing" ? ":processing" : ""),
      );
    }
  }, [expenseQuery.data, hydratedFor]);

  const saveMutation = useMutation<ExpenseRead, ApiError, void>({
    mutationFn: async () => {
      const body: ExpenseUpdate = {
        expense_date: state.expense_date || null,
        supplier: state.supplier || null,
        category: state.category || null,
        subtotal: state.subtotal || null,
        tax_amount: state.tax_amount || null,
        total: state.total || null,
        currency: state.currency || "CAD",
        notes: state.notes || null,
      };
      return apiFetch<ExpenseRead>(`/business/expenses/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      void queryClient.invalidateQueries({ queryKey: ["expense", id] });
      navigate("/expenses");
    },
  });

  const deleteMutation = useMutation<void, ApiError, void>({
    mutationFn: () =>
      apiFetch(`/business/expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      navigate("/expenses");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    saveMutation.mutate();
  }

  function handleDelete() {
    if (!window.confirm("Delete this expense and remove the image?")) return;
    deleteMutation.mutate();
  }

  const status = expenseQuery.data?.status;
  const isProcessing = status === "pending" || status === "processing";
  const ocrError = expenseQuery.data?.ocr_error;

  const statusBanner = useMemo(() => {
    if (!status) return null;
    if (status === "pending" || status === "processing") {
      return {
        text: "Reading your receipt with OCR — fields will fill in shortly.",
        tone: "info" as const,
      };
    }
    if (status === "failed") {
      return {
        text: `OCR couldn't read this image${ocrError ? ` (${ocrError})` : ""}. Fill in the fields below manually.`,
        tone: "warn" as const,
      };
    }
    return null;
  }, [status, ocrError]);

  if (expenseQuery.isLoading || !expenseQuery.data) {
    return (
      <div className="min-h-screen bg-background">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-6">
          <p className="text-muted-foreground">Loading expense…</p>
        </main>
      </div>
    );
  }
  if (expenseQuery.isError) {
    return (
      <div className="min-h-screen bg-background">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-6">
          <p className="text-destructive">
            Failed to load expense:{" "}
            {expenseQuery.error instanceof Error
              ? expenseQuery.error.message
              : "Unknown error"}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h2 className="mb-6 text-2xl font-bold">Edit Expense</h2>

        {statusBanner && (
          <div
            className={
              "mb-4 rounded-md border px-4 py-2 text-sm " +
              (statusBanner.tone === "info"
                ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100"
                : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100")
            }
          >
            {statusBanner.text}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* Image preview */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Receipt</CardTitle>
              </CardHeader>
              <CardContent>
                {imageUrlQuery.data ? (
                  <a
                    href={imageUrlQuery.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block"
                  >
                    <img
                      src={imageUrlQuery.data.url}
                      alt="Uploaded receipt"
                      className="max-h-[60vh] w-full rounded-md border bg-muted object-contain"
                    />
                  </a>
                ) : imageUrlQuery.isLoading ? (
                  <p className="text-muted-foreground">Loading image…</p>
                ) : (
                  <p className="text-muted-foreground">
                    Image preview unavailable.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Editable fields */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_1fr] sm:items-center">
                <Label htmlFor="expense_date">Date</Label>
                <Input
                  id="expense_date"
                  type="date"
                  value={state.expense_date}
                  disabled={isProcessing}
                  onChange={(e) =>
                    setState({ ...state, expense_date: e.target.value })
                  }
                />

                <Label htmlFor="supplier">Supplier</Label>
                <Input
                  id="supplier"
                  value={state.supplier}
                  disabled={isProcessing}
                  onChange={(e) =>
                    setState({ ...state, supplier: e.target.value })
                  }
                />

                <Label htmlFor="category">Category</Label>
                <select
                  id="category"
                  className={SELECT_CLASSES}
                  value={state.category}
                  disabled={isProcessing}
                  onChange={(e) =>
                    setState({ ...state, category: e.target.value })
                  }
                >
                  <option value="">— Pick a category —</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <Label htmlFor="subtotal">Subtotal</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="subtotal"
                    type="number"
                    step="0.01"
                    className="pl-6"
                    value={state.subtotal}
                    disabled={isProcessing}
                    onChange={(e) =>
                      setState({ ...state, subtotal: e.target.value })
                    }
                  />
                </div>

                <Label htmlFor="tax_amount">Tax</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="tax_amount"
                    type="number"
                    step="0.01"
                    className="pl-6"
                    value={state.tax_amount}
                    disabled={isProcessing}
                    onChange={(e) =>
                      setState({ ...state, tax_amount: e.target.value })
                    }
                  />
                </div>

                <Label htmlFor="total">Total</Label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="total"
                    type="number"
                    step="0.01"
                    className="pl-6"
                    value={state.total}
                    disabled={isProcessing}
                    onChange={(e) =>
                      setState({ ...state, total: e.target.value })
                    }
                  />
                </div>

                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  maxLength={3}
                  value={state.currency}
                  disabled={isProcessing}
                  onChange={(e) =>
                    setState({
                      ...state,
                      currency: e.target.value.toUpperCase(),
                    })
                  }
                />

                <Label htmlFor="notes" className="self-start pt-2">
                  Notes
                </Label>
                <textarea
                  id="notes"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                  value={state.notes}
                  disabled={isProcessing}
                  onChange={(e) =>
                    setState({ ...state, notes: e.target.value })
                  }
                />
              </CardContent>
            </Card>
          </div>

          {saveMutation.isError && (
            <p className="mt-3 text-sm text-destructive">
              Save failed:{" "}
              {saveMutation.error instanceof ApiError
                ? typeof saveMutation.error.body === "object" &&
                  saveMutation.error.body &&
                  "detail" in saveMutation.error.body
                  ? String(
                      (saveMutation.error.body as { detail: unknown }).detail,
                    )
                  : `Server error ${saveMutation.error.status}`
                : String(saveMutation.error)}
            </p>
          )}

          {/* Footer actions */}
          <div className="mt-4 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate("/expenses")}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saveMutation.isPending || isProcessing}
              >
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
