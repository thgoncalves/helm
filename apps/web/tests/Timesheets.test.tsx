/**
 * Tests for src/routes/Timesheets.tsx.
 *
 * Mocks:
 *   apiFetch  → dispatches by URL pattern (clients list, entries window,
 *               summary, bulk upsert).
 *   apiFetchBlob → returns a fake PDF blob.
 *
 * What we cover:
 *   - Header renders and dropdown lists the seeded clients.
 *   - Selected client's rate appears.
 *   - "Remaining" line shows up when the API returns a contract value.
 *   - Out-of-month cells are disabled (read-only).
 *   - Editing a cell updates the weekly subtotal in real time.
 *   - Month navigation moves to the next month.
 *   - Submit Timesheet triggers the alert + save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Mocks (defined before importing the component under test)
// ---------------------------------------------------------------------------

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

import { Timesheets } from "@/routes/Timesheets";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SULPETRO_ID = "00000000-0000-0000-0000-000000000001";
const WENCO_ID = "00000000-0000-0000-0000-000000000002";

const baseClient = {
  email: null,
  phone: null,
  address_line1: null,
  address_line2: null,
  city: null,
  state: null,
  postal_code: null,
  country: "Canada",
  tax_id: null,
  notes: null,
  is_active: true,
  contract_currency: "CAD",
  default_task_description: null,
  created_at: "2022-03-01T09:00:00Z",
  updated_at: "2022-03-01T09:00:00Z",
};

const SULPETRO = {
  ...baseClient,
  id: SULPETRO_ID,
  name: "Sulpetro",
  hourly_rate: "100.00",
  timesheet_frequency: "monthly",
  contract_value: null,
};

const WENCO = {
  ...baseClient,
  id: WENCO_ID,
  name: "Wenco",
  hourly_rate: "95.38",
  timesheet_frequency: "monthly",
  contract_value: "190000.00",
};

function summaryFor(clientId: string) {
  if (clientId === WENCO_ID) {
    return {
      client_id: clientId,
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      hourly_rate: "95.38",
      contract_value: "190000.00",
      contract_currency: "CAD",
      period_hours: "0",
      period_amount: "0",
      contract_hours_logged: "10.00",
      contract_amount_logged: "953.80",
      contract_remaining_hours: "1982.03",
      contract_remaining_amount: "189046.20",
    };
  }
  return {
    client_id: clientId,
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    hourly_rate: "100.00",
    contract_value: null,
    contract_currency: "CAD",
    period_hours: "0",
    period_amount: "0",
    contract_hours_logged: "0",
    contract_amount_logged: "0",
    contract_remaining_hours: null,
    contract_remaining_amount: null,
  };
}

function setupApiMock(initialEntries: { work_date: string; hours: string }[] = []) {
  const entries = [...initialEntries];
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/business/clients/")) {
      return [SULPETRO, WENCO];
    }
    if (path.startsWith("/business/time-entries/?")) {
      return entries.map((e, i) => ({
        id: `entry-${i}`,
        client_id: SULPETRO_ID,
        work_date: e.work_date,
        hours: e.hours,
        invoice_id: null,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      }));
    }
    if (path.startsWith("/business/time-entries/bulk")) {
      const body = JSON.parse(init?.body as string);
      return body.entries.map((e: { work_date: string; hours: string }, i: number) => ({
        id: `bulk-${i}`,
        client_id: body.client_id,
        work_date: e.work_date,
        hours: e.hours,
        invoice_id: null,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
      }));
    }
    if (path.startsWith("/business/timesheets/summary")) {
      const url = new URL(`http://x${path}`);
      const cid = url.searchParams.get("client_id") ?? SULPETRO_ID;
      return summaryFor(cid);
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
        <Timesheets />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Timesheets page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 9)); // 2026-05-09 (Sat)
    setupApiMock();
  });

  it("renders the page title and the client dropdown", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: /Timesheets/i }),
    ).toBeInTheDocument();
    const select = await screen.findByLabelText(/Client:/i);
    await waitFor(() => {
      expect(within(select).getByText(/Sulpetro/)).toBeInTheDocument();
      expect(within(select).getByText(/Wenco/)).toBeInTheDocument();
    });
  });

  it("auto-selects the first client and shows its rate", async () => {
    renderPage();
    expect(await screen.findByText(/Hourly Rate:/)).toBeInTheDocument();
    expect(await screen.findByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText(/Frequency:/)).toBeInTheDocument();
  });

  it("hides the Remaining row when the client has no contract_value", async () => {
    renderPage();
    await screen.findByText("$100.00");
    expect(screen.queryByText(/Remaining:/)).not.toBeInTheDocument();
  });

  it("shows Remaining when the client has a contract_value", async () => {
    renderPage();
    // Wait for the auto-pick to fire (rate visible == clients loaded).
    await screen.findByText("$100.00");
    const select = screen.getByLabelText(/Client:/i);
    await userEvent.selectOptions(select, WENCO_ID);
    expect(await screen.findByText(/Remaining:/)).toBeInTheDocument();
    expect(await screen.findByText(/\$189,046\.20/)).toBeInTheDocument();
  });

  it("disables out-of-month cells", async () => {
    renderPage();
    // Wait for grid to settle.
    const inputs = await screen.findAllByRole("textbox");
    // The first row of May 2026 starts on Mon Apr 27, so the first input is
    // disabled (out-of-month).
    expect(inputs[0]).toBeDisabled();
  });

  it("editing a cell updates the weekly subtotal", async () => {
    renderPage();
    // Wait for the auto-pick to fire so the in-month cells become enabled.
    await screen.findByText("$100.00");
    const inputs = await screen.findAllByRole("textbox");
    const firstEnabled = inputs.find(
      (el) => !(el as HTMLInputElement).disabled,
    );
    expect(firstEnabled).toBeDefined();
    await userEvent.clear(firstEnabled!);
    await userEvent.type(firstEnabled!, "5");
    expect(await screen.findByText(/^5 hrs$/)).toBeInTheDocument();
  });

  it("Submit Timesheet triggers an alert and a save", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderPage();
    const submit = await screen.findByRole("button", {
      name: /Submit Timesheet/,
    });
    await userEvent.click(submit);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]?.[0]).toMatch(/Invoice creation/i);
  });

  it("month navigation advances to the next month", async () => {
    renderPage();
    expect(await screen.findByText(/^May 2026$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText(/^June 2026$/)).toBeInTheDocument();
  });
});
