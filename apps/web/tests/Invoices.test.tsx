/**
 * Tests for src/routes/Invoices.tsx.
 *
 * Mocks apiFetch and asserts the landing page wires its filters and totals
 * cards correctly.
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

import { Invoices } from "@/routes/Invoices";

const CP_ID = "00000000-0000-0000-0000-000000000aaa";
const SULPETRO_ID = "00000000-0000-0000-0000-000000000001";

const CLIENTS = [
  { id: SULPETRO_ID, name: "Sulpetro" },
  { id: CP_ID, name: "CP" },
];

function makeInvoice(over: Partial<Record<string, unknown>>) {
  return {
    id: "id-" + (over.invoice_number as string),
    invoice_number: "INV-2026-0001",
    issue_date: "2026-05-01",
    due_date: "2026-05-31",
    client_id: CP_ID,
    status: "draft",
    currency: "CAD",
    subtotal: "0.00",
    tax_amount: "0.00",
    total: "0.00",
    notes: null,
    payment_terms: "Net 30",
    attachments_path: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function setupApi(invoiceList: ReturnType<typeof makeInvoice>[]) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/business/clients/")) return CLIENTS;
    if (path.startsWith("/business/invoices/")) {
      const url = new URL(`http://x${path}`);
      const status = url.searchParams.get("status");
      const clientId = url.searchParams.get("client_id");
      let filtered = [...invoiceList];
      if (status) filtered = filtered.filter((i) => i.status === status);
      if (clientId) filtered = filtered.filter((i) => i.client_id === clientId);
      // Totals
      const totals = filtered.reduce(
        (acc, inv) => {
          const t = Number(inv.total);
          acc.total += t;
          if (inv.status === "draft") acc.draft += t;
          else if (inv.status === "paid") acc.paid += t;
          else if (inv.status === "sent") {
            const due = inv.due_date ? new Date(String(inv.due_date)) : null;
            const today = new Date();
            if (due && due < today) acc.overdue += t;
            else acc.sent += t;
          }
          return acc;
        },
        { draft: 0, sent: 0, overdue: 0, paid: 0, total: 0 },
      );
      return {
        invoices: filtered,
        totals_by_status: {
          draft: totals.draft.toFixed(2),
          sent: totals.sent.toFixed(2),
          overdue: totals.overdue.toFixed(2),
          paid: totals.paid.toFixed(2),
          total: totals.total.toFixed(2),
        },
      };
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
        <Invoices />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Invoices landing page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 11)); // 2026-05-11
  });

  it("defaults the filter to the current fiscal year (Apr 1 → Mar 31)", async () => {
    setupApi([
      makeInvoice({ invoice_number: "INV-2026-0001", total: "1000.00", status: "draft" }),
    ]);
    renderPage();

    // The two date inputs default to FY 2026-04-01 → 2027-03-31.
    await waitFor(() => {
      const dateInputs = screen
        .getAllByDisplayValue(/2026-04-01|2027-03-31/);
      expect(dateInputs.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows the Draft/Sent/Overdue/Paid/Total cards from the API totals", async () => {
    setupApi([
      makeInvoice({ invoice_number: "INV-2026-0001", total: "1000.00", status: "draft" }),
      makeInvoice({ invoice_number: "INV-2026-0002", total: "2000.00", status: "paid" }),
      makeInvoice({
        invoice_number: "INV-2026-0003",
        total: "500.00",
        status: "sent",
        due_date: "2026-05-10",
      }),
    ]);
    renderPage();

    // Wait for rows to render, then assert the totals-by-status card holds
    // the expected aggregate (3500). The individual row totals also exist
    // in the table, so we use the card region itself for the assertion.
    await screen.findByText("INV-2026-0001");
    const totalsCard = screen.getByText(/Totals by Status/i).closest("div");
    expect(totalsCard).not.toBeNull();
    expect(totalsCard!).toHaveTextContent("$3,500.00"); // grand total
    expect(totalsCard!).toHaveTextContent("$1,000.00"); // draft
    expect(totalsCard!).toHaveTextContent("$2,000.00"); // paid
    expect(totalsCard!).toHaveTextContent("$500.00"); // overdue
  });

  it("client-side filters by status=overdue without re-requesting", async () => {
    setupApi([
      makeInvoice({ invoice_number: "INV-2026-0001", total: "1000.00", status: "draft" }),
      makeInvoice({
        invoice_number: "INV-2026-0002",
        total: "500.00",
        status: "sent",
        due_date: "2026-05-10",
      }),
      makeInvoice({
        invoice_number: "INV-2026-0003",
        total: "700.00",
        status: "sent",
        due_date: "2026-06-01",
      }),
    ]);
    renderPage();

    await screen.findByText("INV-2026-0002");
    expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();

    const statusSelect = screen.getByLabelText(/Status filter/i);
    await userEvent.selectOptions(statusSelect, "overdue");

    // Only the overdue one survives.
    expect(screen.getByText("INV-2026-0002")).toBeInTheDocument();
    expect(screen.queryByText("INV-2026-0001")).not.toBeInTheDocument();
    expect(screen.queryByText("INV-2026-0003")).not.toBeInTheDocument();
  });

  it("renders invoice rows with client name lookup", async () => {
    setupApi([
      makeInvoice({
        invoice_number: "INV-2026-0024",
        total: "3100.00",
        client_id: SULPETRO_ID,
        status: "sent",
        due_date: "2026-06-01",
      }),
    ]);
    renderPage();
    const row = (await screen.findByText("INV-2026-0024")).closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("Sulpetro");
    expect(row!).toHaveTextContent("$3,100.00");
  });

  it("filters by search input across invoice # and client name", async () => {
    setupApi([
      makeInvoice({
        invoice_number: "INV-2026-0001",
        client_id: SULPETRO_ID,
        total: "100.00",
      }),
      makeInvoice({
        invoice_number: "INV-2026-0002",
        client_id: CP_ID,
        total: "200.00",
      }),
    ]);
    renderPage();
    await screen.findByText("INV-2026-0001");
    const search = screen.getByLabelText(/Search invoices/i);
    await userEvent.type(search, "Sulpetro");
    expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
    expect(screen.queryByText("INV-2026-0002")).not.toBeInTheDocument();
  });
});
