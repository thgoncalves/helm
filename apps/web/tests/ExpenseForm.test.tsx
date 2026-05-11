/**
 * Tests for src/routes/ExpenseForm.tsx (edit-only).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiFetchBlob: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
      message?: string,
    ) {
      super(message ?? `API error ${status}`);
      this.name = "ApiError";
    }
  },
}));

vi.mock("@/components/SignOutButton", () => ({
  SignOutButton: () => <button>Sign out</button>,
}));

import { ExpenseForm } from "@/routes/ExpenseForm";

const EXPENSE = {
  id: "exp-1",
  status: "ready",
  s3_key: "expenses/2026-05/exp-1.jpg",
  content_type: "image/jpeg",
  size_bytes: 123,
  expense_date: "2026-05-10",
  supplier: "Office Depot",
  category: "Office Supplies",
  subtotal: "95.24",
  tax_amount: "4.76",
  total: "100.00",
  currency: "CAD",
  notes: null,
  ocr_error: null,
  created_at: "2026-05-10T00:00:00Z",
  updated_at: "2026-05-10T00:00:00Z",
};

function setupApi(expense = EXPENSE) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `/business/expenses/${expense.id}` && (!init || init.method === undefined)) {
      return expense;
    }
    if (path === `/business/expenses/${expense.id}/image-url`) {
      return { url: "https://fake-s3.local/get/exp-1.jpg" };
    }
    if (path === `/business/expenses/${expense.id}` && init?.method === "PUT") {
      return { ...expense, ...JSON.parse(init.body as string) };
    }
    if (path === `/business/expenses/${expense.id}` && init?.method === "DELETE") {
      return undefined;
    }
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderForm(expense = EXPENSE) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/expenses/${expense.id}`]}>
        <Routes>
          <Route path="/expenses/:id" element={<ExpenseForm />} />
          <Route path="/expenses" element={<div data-testid="landing" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ExpenseForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it("hydrates fields from the API", async () => {
    renderForm();
    const supplier = (await screen.findByLabelText(
      /Supplier/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(supplier.value).toBe("Office Depot"));
    expect(
      (screen.getByLabelText(/^Total$/i) as HTMLInputElement).value,
    ).toBe("100.00");
  });

  it("shows the image preview using the presigned URL", async () => {
    renderForm();
    const img = (await screen.findByAltText(
      /Uploaded receipt/i,
    )) as HTMLImageElement;
    expect(img.src).toContain("fake-s3.local");
  });

  it("Save sends PUT with edited fields and navigates back", async () => {
    renderForm();
    const supplier = (await screen.findByLabelText(
      /Supplier/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(supplier.value).toBe("Office Depot"));
    await userEvent.clear(supplier);
    await userEvent.type(supplier, "Staples");

    await userEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => {
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeDefined();
      const body = JSON.parse((put![1] as RequestInit).body as string);
      expect(body.supplier).toBe("Staples");
    });
    expect(await screen.findByTestId("landing")).toBeInTheDocument();
  });

  it("Delete confirms then calls DELETE and navigates back", async () => {
    renderForm();
    await screen.findByLabelText(/Supplier/i);
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByTestId("landing")).toBeInTheDocument();
  });

  it("shows a processing banner and disables edit fields when status is pending", async () => {
    setupApi({ ...EXPENSE, status: "pending", supplier: null });
    renderForm();
    expect(
      await screen.findByText(/Reading your receipt with OCR/i),
    ).toBeInTheDocument();
    const supplier = screen.getByLabelText(/Supplier/i) as HTMLInputElement;
    expect(supplier).toBeDisabled();
  });

  it("shows a warning banner with the OCR error when status is failed", async () => {
    setupApi({
      ...EXPENSE,
      status: "failed",
      supplier: null,
      ocr_error: "Textract: BadDocument",
    });
    renderForm();
    expect(
      await screen.findByText(/OCR couldn't read this image/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Textract: BadDocument/)).toBeInTheDocument();
  });
});
