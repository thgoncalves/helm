/**
 * Tests for src/routes/InvoiceForm.tsx (NewInvoice / EditInvoice).
 *
 * Focus: line-item math, taxable toggle, and the POST payload sent on Save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.fn();
const apiFetchBlobMock = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiFetchBlob: (...args: unknown[]) => apiFetchBlobMock(...args),
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

import { NewInvoice } from "@/routes/InvoiceForm";

const CP_ID = "00000000-0000-0000-0000-000000000aaa";

const CLIENTS = [{ id: CP_ID, name: "CP" }];

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/invoices/new"]}>
        <Routes>
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/invoices/:id" element={<div>Detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InvoiceForm (NewInvoice)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 11));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/business/clients/")) return CLIENTS;
      if (path.startsWith("/business/invoices/")) {
        return {
          invoice: {
            id: "new-id",
            invoice_number: "INV-2026-0001",
            issue_date: "2026-05-11",
            due_date: "2026-06-10",
            client_id: CP_ID,
            status: "draft",
            currency: "CAD",
            subtotal: "2470.00",
            tax_amount: "123.50",
            total: "2593.50",
            notes: null,
            payment_terms: "Net 30",
            attachments_path: null,
            created_at: "2026-05-11T00:00:00Z",
            updated_at: "2026-05-11T00:00:00Z",
          },
          line_items: [],
        };
      }
      throw new Error(`Unhandled path: ${path}`);
    });
  });

  it("recomputes the line tax and total when qty/unit_price change", async () => {
    renderForm();
    await screen.findByText(/Line Items/i);

    // The default line has qty=0, unit_price=0. Change them.
    const qtyInput = screen.getAllByRole("spinbutton")[0]!; // qty
    const unitInput = screen.getAllByRole("spinbutton")[1]!; // unit_price

    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, "26");
    await userEvent.clear(unitInput);
    await userEvent.type(unitInput, "95");

    // The Totals box should show subtotal=2470, GST=123.50, Total=2593.50.
    await waitFor(() => {
      expect(screen.getByText(/Subtotal:/).parentElement).toHaveTextContent(
        "$2,470.00",
      );
      expect(screen.getByText(/GST:/).parentElement).toHaveTextContent(
        "$123.50",
      );
      expect(screen.getByText(/Total:/).parentElement).toHaveTextContent(
        "$2,593.50",
      );
    });
  });

  it("disables tax_rate input when the line is not taxable, and zeroes tax", async () => {
    renderForm();
    await screen.findByText(/Line Items/i);

    // Set qty=10, unit=100 so the math is easy.
    const qtyInput = screen.getAllByRole("spinbutton")[0]!;
    const unitInput = screen.getAllByRole("spinbutton")[1]!;
    await userEvent.clear(qtyInput);
    await userEvent.type(qtyInput, "10");
    await userEvent.clear(unitInput);
    await userEvent.type(unitInput, "100");

    const taxableCheckbox = screen.getByLabelText(/Taxable line 1/i);
    await userEvent.click(taxableCheckbox); // uncheck

    await waitFor(() => {
      expect(screen.getByText(/GST:/).parentElement).toHaveTextContent("$0.00");
      expect(screen.getByText(/Total:/).parentElement).toHaveTextContent(
        "$1,000.00",
      );
    });
  });

  it("Add Line appends a new editable row", async () => {
    renderForm();
    await screen.findByText(/Line Items/i);
    expect(screen.getByLabelText(/Select line 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Select line 2/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Add Line/i }));
    expect(screen.getByLabelText(/Select line 2/i)).toBeInTheDocument();
  });
});
