/**
 * Tests for src/routes/Payments.tsx (landing page).
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

import { Payments } from "@/routes/Payments";

function makePayment(over: Partial<Record<string, unknown>>) {
  return {
    id: "p-" + String(over.id ?? "1"),
    payment_date: "2026-06-01",
    invoice_id: "i-1",
    invoice_number: "INV-2026-0010",
    client_id: "c-cp",
    client_name: "CP",
    amount: "3391.50",
    deduction_amount: "18.00",
    net: "3373.50",
    payment_method: "EFT",
    reference: "EFT000000271809",
    notes: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function setupApi(rows: ReturnType<typeof makePayment>[]) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/business/payments/")) {
      return rows;
    }
    throw new Error(`Unhandled path: ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Payments />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Payments landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 11));
  });

  it("renders enriched rows with gross/deduction/net columns", async () => {
    setupApi([
      makePayment({
        id: "1",
        amount: "3391.50",
        deduction_amount: "18.00",
        net: "3373.50",
      }),
    ]);
    renderPage();
    const row = (await screen.findByText("INV-2026-0010")).closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("CP");
    expect(row!).toHaveTextContent("$3,391.50"); // gross
    expect(row!).toHaveTextContent("$18.00"); // deduction
    expect(row!).toHaveTextContent("$3,373.50"); // net
    expect(row!).toHaveTextContent("EFT");
  });

  it("shows a dash when there is no deduction", async () => {
    setupApi([
      makePayment({
        id: "2",
        amount: "2593.50",
        deduction_amount: "0",
        net: "2593.50",
      }),
    ]);
    renderPage();
    const row = (await screen.findByText("INV-2026-0010")).closest("tr");
    expect(row).not.toBeNull();
    // Deduction column should render an em-dash.
    expect(row!.children[4]?.textContent).toBe("—");
  });

  it("client-side search filters by invoice #, client, or reference", async () => {
    setupApi([
      makePayment({
        id: "1",
        invoice_number: "INV-2026-0010",
        client_name: "CP",
        reference: "EFT001",
      }),
      makePayment({
        id: "2",
        invoice_number: "INV-2026-0025",
        client_name: "Sulpetro",
        reference: "EFT002",
      }),
    ]);
    renderPage();
    await screen.findByText("INV-2026-0010");
    const search = screen.getByLabelText(/Search payments/i);
    await userEvent.type(search, "Sulpetro");
    expect(screen.queryByText("INV-2026-0010")).not.toBeInTheDocument();
    expect(screen.getByText("INV-2026-0025")).toBeInTheDocument();
  });

  it("Edit/Delete buttons are disabled until a row is selected", async () => {
    setupApi([makePayment({ id: "1" })]);
    renderPage();
    await screen.findByText("INV-2026-0010");
    const editBtn = screen.getByRole("button", { name: /^Edit$/ });
    const deleteBtn = screen.getByRole("button", { name: /^Delete$/ });
    expect(editBtn).toBeDisabled();
    expect(deleteBtn).toBeDisabled();

    await userEvent.click(screen.getByText("INV-2026-0010"));
    await waitFor(() => {
      expect(editBtn).not.toBeDisabled();
      expect(deleteBtn).not.toBeDisabled();
    });
  });

  it("defaults filter to the current fiscal year", async () => {
    setupApi([makePayment({ id: "1" })]);
    renderPage();
    await waitFor(() => {
      const inputs = screen.getAllByDisplayValue(/2026-04-01|2027-03-31/);
      expect(inputs.length).toBeGreaterThanOrEqual(2);
    });
  });
});
