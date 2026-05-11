/**
 * Tests for src/routes/Transfers.tsx (landing page).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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

import { Transfers } from "@/routes/Transfers";

const SUMMARY = {
  total_transferred: "37845.00",
  transaction_count: 10,
  est_company_tax: "11353.50",
  est_personal_tax: "12299.63",
  tax_exposure: "23653.13",
};

const TRANSFERS = [
  {
    id: "t-1",
    transfer_date: "2026-02-05",
    amount: "13000.00",
    method: "EFT",
    purpose: null,
    category: "Salary",
    estimated_tax_company: "3900.00",
    estimated_tax_personal: "4225.00",
    actual_tax_paid_company: null,
    actual_tax_paid_personal: null,
    tax_ledger_link_company: null,
    tax_ledger_link_personal: null,
    notes: null,
    created_at: "2026-02-05T00:00:00Z",
    updated_at: "2026-02-05T00:00:00Z",
  },
  {
    id: "t-2",
    transfer_date: "2025-10-06",
    amount: "2000.00",
    method: "EFT",
    purpose: null,
    category: "Salary",
    estimated_tax_company: "600.00",
    estimated_tax_personal: "650.00",
    actual_tax_paid_company: null,
    actual_tax_paid_personal: null,
    tax_ledger_link_company: null,
    tax_ledger_link_personal: null,
    notes: null,
    created_at: "2025-10-06T00:00:00Z",
    updated_at: "2025-10-06T00:00:00Z",
  },
];

function setupApi() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/business/transfers/summary")) return SUMMARY;
    if (path.startsWith("/business/transfers/")) return TRANSFERS;
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Transfers />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Transfers landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 1, 5)); // 2026-02-05 → FY 2025
    setupApi();
  });

  it("defaults the fiscal-year filter to the current FY", async () => {
    renderPage();
    const select = await screen.findByLabelText(/Fiscal year filter/i);
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe("2025");
    });
  });

  it("renders the four KPI fields from the summary", async () => {
    renderPage();
    // The KPI labels are in the Transfers + Tax Estimates cards; the
    // identical "Est. Company Tax" / "Est. Personal Tax" strings also
    // appear in the table header, so scope each lookup to its KPI box.
    await waitFor(() => {
      const all = screen.getAllByText("$37,845.00");
      expect(all.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("$11,353.50")).toBeInTheDocument();
    expect(screen.getByText("$12,299.63")).toBeInTheDocument();
    expect(screen.getByText("$23,653.13")).toBeInTheDocument();
  });

  it("renders rows with Amount, Category, Method, and tax columns", async () => {
    renderPage();
    const row = (await screen.findByText("$13,000.00")).closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("Salary");
    expect(row!).toHaveTextContent("EFT");
    expect(row!).toHaveTextContent("$3,900.00");
    expect(row!).toHaveTextContent("$4,225.00");
  });

  it("Edit/Delete footer buttons need a selected row", async () => {
    renderPage();
    const cell = await screen.findByText("$13,000.00");
    const editBtn = screen.getByRole("button", { name: /^Edit$/ });
    const deleteBtn = screen.getByRole("button", { name: /^Delete$/ });
    expect(editBtn).toBeDisabled();
    expect(deleteBtn).toBeDisabled();
    await userEvent.click(cell);
    await waitFor(() => {
      expect(editBtn).not.toBeDisabled();
      expect(deleteBtn).not.toBeDisabled();
    });
  });
});
