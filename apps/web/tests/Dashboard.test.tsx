/**
 * Tests for src/routes/Dashboard.tsx.
 *
 * Recharts is heavy and renders SVG — we don't assert on chart pixels.
 * We do verify:
 *  - KPI hydration (label + value + delta indicator)
 *  - Click-to-drill navigation on KPI cards
 *  - Aging cards render and link out
 *  - Empty-state fallbacks
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

// Recharts uses ResponsiveContainer which depends on ResizeObserver.
// jsdom doesn't ship it.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
  ResizeObserverMock;

import { Dashboard } from "@/routes/Dashboard";

const DASHBOARD = {
  fy_start: "2026-04-01",
  fy_end: "2027-03-31",
  today: "2026-05-11",
  kpis: {
    fy_invoiced: {
      value: "15382.50",
      prev_value: "85234.50",
      delta_pct: "-82.0",
      detail: null,
    },
    fy_received: {
      value: "23735.75",
      prev_value: "69620.50",
      delta_pct: "-65.9",
      detail: null,
    },
    outstanding: {
      value: "7489.00",
      prev_value: null,
      delta_pct: null,
      detail: "3 invoices",
    },
    invoice_count: {
      value: "5",
      prev_value: "27",
      delta_pct: "-81.5",
      detail: "this FY",
    },
    gst_collected: {
      value: "332.50",
      prev_value: null,
      delta_pct: null,
      detail: "this FY",
    },
    gst_owed: {
      value: "123.50",
      prev_value: null,
      delta_pct: null,
      detail: null,
    },
    transfers_fy: {
      value: "0.00",
      prev_value: "37845.00",
      delta_pct: "-100.0",
      detail: null,
    },
    tax_exposure: {
      value: "0.00",
      prev_value: null,
      delta_pct: null,
      detail: "this FY",
    },
  },
  monthly_revenue: [
    {
      month: "Apr",
      total: "9290.00",
      by_client: [
        {
          client_id: "c-sulp",
          client_name: "Sulpetro",
          amount: "5300.00",
        },
        { client_id: "c-cp", client_name: "CP", amount: "3990.00" },
      ],
    },
    ...["May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"].map(
      (m) => ({ month: m, total: "0.00", by_client: [] }),
    ),
  ],
  top_clients: [
    { client_id: "c-sulp", client_name: "Sulpetro", total: "8400.00" },
    { client_id: "c-cp", client_name: "CP", total: "6982.50" },
  ],
  cash_flow: ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"].map(
    (m) => ({ month: m, invoiced: "0.00", received: "0.00" }),
  ),
  quarterly: [
    { quarter: "Q1", invoiced: "15382.50", received: "20342.75" },
    { quarter: "Q2", invoiced: "0.00", received: "0.00" },
    { quarter: "Q3", invoiced: "0.00", received: "0.00" },
    { quarter: "Q4", invoiced: "0.00", received: "3393.00" },
  ],
  by_fiscal_year: [
    { fy_label: "2024/25", invoiced: "187000.00", received: "187000.00" },
    { fy_label: "2025/26", invoiced: "85000.00", received: "85000.00" },
    { fy_label: "2026/27", invoiced: "15382.50", received: "23735.75" },
  ],
  aging: [
    { label: "0-30", count: 2, amount: "5300.00" },
    { label: "31-60", count: 1, amount: "2189.00" },
    { label: "61-90", count: 0, amount: "0.00" },
    { label: "90+", count: 0, amount: "0.00" },
  ],
};

function setupApi(payload = DASHBOARD) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/business/dashboard/") return payload;
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/invoices" element={<div data-testid="invoices-page" />} />
          <Route path="/payments" element={<div data-testid="payments-page" />} />
          <Route path="/taxes" element={<div data-testid="taxes-page" />} />
          <Route path="/transfers" element={<div data-testid="transfers-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it("renders the FY label from the response", async () => {
    renderPage();
    expect(await screen.findByText("FY 2026/27")).toBeInTheDocument();
  });

  it("hydrates the four Key Metric cards with formatted values + deltas", async () => {
    renderPage();
    // Each KPI label has a parent card carrying both the value and the delta.
    const invoicedCard =
      (await screen.findByText("FY Invoiced")).closest("div.h-full") ??
      (await screen.findByText("FY Invoiced")).parentElement!;
    expect(invoicedCard).toHaveTextContent("$15,382.50");
    expect(invoicedCard).toHaveTextContent("82.0%");

    const outstandingCard =
      screen.getByText("Outstanding").closest("div.h-full") ??
      screen.getByText("Outstanding").parentElement!;
    expect(outstandingCard).toHaveTextContent("$7,489.00");
    expect(outstandingCard).toHaveTextContent("3 invoices");

    // The Invoices KPI label collides with the nav link — assert on the
    // unique 81.5% delta which only appears on that card.
    const deltaSpan = screen.getByText(/81\.5%/);
    const countCard = deltaSpan.closest("div.p-4");
    expect(countCard).not.toBeNull();
    expect(countCard!).toHaveTextContent("5");
  });

  it("renders the Tax / Transfers row", async () => {
    renderPage();
    await screen.findByText("GST Collected");
    expect(screen.getByText("GST Owed")).toBeInTheDocument();
    expect(screen.getByText("Transfers FY")).toBeInTheDocument();
    expect(screen.getByText("Tax Exposure")).toBeInTheDocument();
  });

  it("KPI cards navigate to the right listing on click", async () => {
    renderPage();
    await userEvent.click(await screen.findByText("FY Received"));
    expect(await screen.findByTestId("payments-page")).toBeInTheDocument();
  });

  it("renders aging buckets and links them to /invoices", async () => {
    renderPage();
    await screen.findByText(/Outstanding by Age/);
    expect(screen.getByText("0-30 days")).toBeInTheDocument();
    expect(screen.getByText("31-60 days")).toBeInTheDocument();
    // Click one — should land on /invoices.
    const bucket = screen.getByText("0-30 days").closest("a");
    expect(bucket).not.toBeNull();
    await userEvent.click(bucket!);
    expect(await screen.findByTestId("invoices-page")).toBeInTheDocument();
  });

  it("shows empty-state copy when no historical FY data", async () => {
    setupApi({ ...DASHBOARD, by_fiscal_year: [], top_clients: [] });
    renderPage();
    expect(
      await screen.findByText("No clients invoiced this FY yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No historical data yet."),
    ).toBeInTheDocument();
  });
});
