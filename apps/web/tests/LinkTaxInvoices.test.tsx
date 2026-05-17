/**
 * Tests for src/routes/LinkTaxInvoices.tsx — the Link/Unlink dialog.
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

import { LinkTaxInvoices } from "@/routes/LinkTaxInvoices";

const PAYMENT = {
  payment: {
    id: "p-1",
    tax_id: null,
    payment_date: "2026-04-28",
    amount: "802.75",
    payment_method: "ATO",
    payment_reference: "95F20-8364485",
    fiscal_year: null,
    notes: null,
    created_at: "2026-04-28T00:00:00Z",
    updated_at: "2026-04-28T00:00:00Z",
  },
  linked_invoices: [],
};

const LINKABLE = [
  {
    invoice_id: "i-a",
    invoice_number: "INV-2026-0016",
    client_id: "c-cp",
    client_name: "CP",
    issue_date: "2026-02-26",
    total: "3990.00",
    tax_amount: "190.00",
    is_linked: true,
  },
  {
    invoice_id: "i-b",
    invoice_number: "INV-2026-0017",
    client_id: "c-cp",
    client_name: "CP",
    issue_date: "2026-03-06",
    total: "2992.50",
    tax_amount: "142.50",
    is_linked: true,
  },
  {
    invoice_id: "i-c",
    invoice_number: "INV-2026-0025",
    client_id: "c-cp",
    client_name: "CP",
    issue_date: "2026-05-01",
    total: "2593.50",
    tax_amount: "123.50",
    is_linked: false,
  },
];

function setupApi(linkedSet: string[] = ["i-a", "i-b"]) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/business/tax-payments/p-1") return PAYMENT;
    if (path === "/business/tax-payments/p-1/linkable-invoices") {
      return LINKABLE.map((i) => ({
        ...i,
        is_linked: linkedSet.includes(i.invoice_id),
      }));
    }
    if (path === "/business/tax-payments/p-1/links" && init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      return LINKABLE.filter((i) => body.invoice_ids.includes(i.invoice_id));
    }
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/taxes/p-1/link"]}>
        <Routes>
          <Route path="/taxes/:id/link" element={<LinkTaxInvoices />} />
          <Route path="/taxes/:id" element={<div>Edit page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LinkTaxInvoices dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it("seeds checkboxes from is_linked on the linkable feed", async () => {
    renderDialog();
    const cb_a = (await screen.findByLabelText(/Toggle INV-2026-0016/)) as HTMLInputElement;
    const cb_b = screen.getByLabelText(/Toggle INV-2026-0017/) as HTMLInputElement;
    const cb_c = screen.getByLabelText(/Toggle INV-2026-0025/) as HTMLInputElement;
    expect(cb_a.checked).toBe(true);
    expect(cb_b.checked).toBe(true);
    expect(cb_c.checked).toBe(false);
  });

  it("shows the selected summary line and updates as you toggle", async () => {
    renderDialog();
    await screen.findByLabelText(/Toggle INV-2026-0016/);
    // Initially 2 selected; income = 3990 + 2992.50 = 6982.50; gst = 190 + 142.50 = 332.50
    expect(
      screen.getByText(/Selected:\s*2\s*invoices/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\$6,982\.50/)).toBeInTheDocument();
    expect(screen.getByText(/\$332\.50/)).toBeInTheDocument();

    // Tick the third one.
    await userEvent.click(screen.getByLabelText(/Toggle INV-2026-0025/));
    await waitFor(() => {
      expect(
        screen.getByText(/Selected:\s*3\s*invoices/),
      ).toBeInTheDocument();
    });
  });

  it("Select All / Deselect All update the selection", async () => {
    renderDialog();
    await screen.findByLabelText(/Toggle INV-2026-0016/);
    await userEvent.click(screen.getByRole("button", { name: /Select All/ }));
    expect(screen.getByText(/Selected:\s*3\s*invoices/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Deselect All/ }));
    expect(screen.getByText(/Selected:\s*0\s*invoices/)).toBeInTheDocument();
  });

  it("Save POSTs the selected ids and navigates to /taxes/:id", async () => {
    renderDialog();
    await screen.findByLabelText(/Toggle INV-2026-0016/);
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => {
      const calls = apiFetchMock.mock.calls;
      const putCall = calls.find(
        (c) =>
          c[0] === "/business/tax-payments/p-1/links" &&
          (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.invoice_ids).toEqual(["i-a", "i-b"]);
    });
    expect(await screen.findByText("Edit page")).toBeInTheDocument();
  });
});
