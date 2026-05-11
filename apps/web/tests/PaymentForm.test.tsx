/**
 * Tests for src/routes/PaymentForm.tsx (NewPayment).
 *
 * Focus: net = gross - deduction live math, invoice dropdown options, and
 * balance-due readout.
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

import { NewPayment } from "@/routes/PaymentForm";

const INVOICE_OPTIONS = [
  {
    invoice_id: "i-1",
    invoice_number: "INV-2026-0010",
    client_id: "c-cp",
    client_name: "CP",
    total: "3391.50",
    balance_due: "3391.50",
    status: "sent",
  },
];

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/payments/new"]}>
        <Routes>
          <Route path="/payments/new" element={<NewPayment />} />
          <Route path="/payments" element={<div>Landing page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PaymentForm (NewPayment)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 11));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/business/payments/invoice-options") {
        return INVOICE_OPTIONS;
      }
      throw new Error(`Unhandled: ${path}`);
    });
  });

  it("populates the invoice dropdown and shows balance-due on select", async () => {
    renderForm();
    const select = await screen.findByLabelText(/Invoice \*/i);
    await screen.findByRole("option", { name: /INV-2026-0010/ });
    await userEvent.selectOptions(select, "i-1");
    await waitFor(() => {
      // Find the Balance Due label and assert its sibling cell.
      const label = screen.getByText("Balance Due");
      expect(label.nextElementSibling?.textContent).toMatch(/\$3,391\.50/);
    });
  });

  it("recomputes Net Amount Received as gross - deduction", async () => {
    renderForm();
    await screen.findByLabelText(/Invoice \*/i);

    const gross = screen.getByLabelText(/Gross Amount/i);
    const deduction = screen.getByLabelText(/Deduction Amount/i);

    await userEvent.clear(gross);
    await userEvent.type(gross, "3391.50");
    await userEvent.clear(deduction);
    await userEvent.type(deduction, "18");

    await waitFor(() => {
      // The Net line shows the green amount.
      const netLabel = screen.getByText(/Net Amount Received/i);
      expect(netLabel.nextElementSibling?.textContent).toMatch(/\$3,373\.50/);
    });
  });

  it("Save button is disabled until an invoice is selected", async () => {
    renderForm();
    await screen.findByLabelText(/Invoice \*/i);
    const save = screen.getByRole("button", { name: /Save/ });
    expect(save).toBeDisabled();

    await screen.findByRole("option", { name: /INV-2026-0010/ });
    await userEvent.selectOptions(screen.getByLabelText(/Invoice \*/i), "i-1");
    expect(save).not.toBeDisabled();
  });
});
