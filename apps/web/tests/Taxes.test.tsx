/**
 * Tests for src/routes/Taxes.tsx (landing page).
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

import { Taxes } from "@/routes/Taxes";

const SUMMARY = {
  gst_unpaid: "123.50",
  unpaid_income: "2593.50",
  total_gst_paid: "30659.43",
};

const PAYMENTS = [
  {
    id: "p-1",
    payment_date: "2026-04-28",
    amount: "802.75",
    payment_method: "ATO",
    payment_reference: "95F20-8364485",
    notes: null,
    invoice_count: 6,
    income: "16857.75",
  },
  {
    id: "p-2",
    payment_date: "2026-02-20",
    amount: "1244.50",
    payment_method: "ATO",
    payment_reference: "8re3H-0960350",
    notes: null,
    invoice_count: 11,
    income: "26134.50",
  },
];

const UNPAID = [
  {
    invoice_id: "i-1",
    invoice_number: "INV-2026-0025",
    client_id: "c-cp",
    client_name: "CP",
    issue_date: "2026-05-01",
    total: "2593.50",
    tax_amount: "123.50",
  },
];

function setupApi() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/business/tax-payments/summary") return SUMMARY;
    if (path === "/business/tax-payments/") return PAYMENTS;
    if (path === "/business/tax-payments/unpaid-invoices") return UNPAID;
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/taxes"]}>
        <Routes>
          <Route path="/taxes" element={<Taxes />} />
          <Route
            path="/taxes/:id"
            element={<div data-testid="edit-page" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Taxes landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it("renders the three KPI cards with formatted amounts", async () => {
    renderPage();
    // Wait for the summary value to actually replace the 0.00 placeholder.
    await waitFor(() => {
      const unpaidCard = screen.getByText(/GST Unpaid/).parentElement;
      expect(unpaidCard!).toHaveTextContent("$123.50");
    });

    const incomeCard = screen.getByText(/Unpaid Income/).parentElement;
    expect(incomeCard!).toHaveTextContent("$2,593.50");

    const paidCard = screen.getByText(/Total GST Paid/).parentElement;
    expect(paidCard!).toHaveTextContent("$30,659.43");
  });

  it("renders enriched GST payment rows with invoice count and income", async () => {
    renderPage();
    const row = (await screen.findByText("95F20-8364485")).closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("ATO");
    expect(row!).toHaveTextContent("6");
    expect(row!).toHaveTextContent("$16,857.75");
    expect(row!).toHaveTextContent("$802.75");
  });

  it("renders the Invoices with Unpaid GST table", async () => {
    renderPage();
    await screen.findByText("INV-2026-0025");
    const row = screen.getByText("INV-2026-0025").closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("CP");
    expect(row!).toHaveTextContent("$2,593.50");
    expect(row!).toHaveTextContent("$123.50");
  });

  it("clicking a GST payment row navigates to its edit page", async () => {
    renderPage();
    await userEvent.click(await screen.findByText("95F20-8364485"));
    expect(await screen.findByTestId("edit-page")).toBeInTheDocument();
  });
});
