/**
 * Tests for src/routes/Expenses.tsx — the receipts landing page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.fn();
// Spy on the global fetch (used for the presigned PUT to S3).
const fetchSpy = vi.fn();

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

import { Expenses } from "@/routes/Expenses";

function makeExpense(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "exp-" + (over.id ?? "1"),
    status: "ready",
    s3_key: "expenses/2026-05/exp-1.jpg",
    content_type: "image/jpeg",
    size_bytes: 123456,
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
    ...over,
  };
}

function setupApi(rows: ReturnType<typeof makeExpense>[]) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/business/expenses/") && (!init || init.method === undefined)) {
      return rows;
    }
    if (path === "/business/expenses/" && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const created = makeExpense({
        id: "new-1",
        status: "pending",
        supplier: null,
        total: null,
        tax_amount: null,
        expense_date: null,
        content_type: body.content_type,
      });
      rows.push(created);
      return {
        expense: created,
        upload_url:
          "https://fake-s3.local/helm-receipts-test/expenses/2026-05/new-1.jpg?op=put",
      };
    }
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/expenses"]}>
        <Routes>
          <Route path="/expenses" element={<Expenses />} />
          <Route
            path="/expenses/:id"
            element={<div data-testid="edit-page" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Expenses landing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(2026, 4, 11));
    fetchSpy.mockReset();
    // Replace the global fetch — the upload mutation uses it for the
    // direct S3 PUT.
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("renders enriched rows with status badge, supplier, total", async () => {
    setupApi([
      makeExpense({
        id: "1",
        supplier: "Office Depot",
        total: "100.00",
      }),
    ]);
    renderPage();
    const row = (await screen.findByText("Office Depot")).closest("tr");
    expect(row).not.toBeNull();
    expect(row!).toHaveTextContent("Ready");
    expect(row!).toHaveTextContent("$100.00");
  });

  it("clicking a row navigates to the edit page", async () => {
    setupApi([makeExpense({ id: "1", supplier: "Stripe" })]);
    renderPage();
    await userEvent.click(await screen.findByText("Stripe"));
    expect(await screen.findByTestId("edit-page")).toBeInTheDocument();
  });

  it("New Expense button uploads via the presigned URL flow", async () => {
    setupApi([]);
    renderPage();
    // Reach the hidden file input — the visible button just clicks it.
    const fileInput = (await screen.findByLabelText(
      /Upload receipt/i,
    )) as HTMLInputElement;
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "rcpt.jpg", {
      type: "image/jpeg",
    });
    await userEvent.upload(fileInput, file);

    await waitFor(() => {
      // POST happened first.
      const calls = apiFetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method]);
      expect(
        calls.find(([p, m]) => p === "/business/expenses/" && m === "POST"),
      ).toBeDefined();
    });
    // Then the direct PUT to the S3 presigned URL.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("fake-s3.local");
      expect((init as RequestInit).method).toBe("PUT");
    });
  });

  it("filters out matching rows when search is non-empty", async () => {
    setupApi([
      makeExpense({ id: "1", supplier: "AWS" }),
      makeExpense({ id: "2", supplier: "Vercel" }),
    ]);
    renderPage();
    await screen.findByText("AWS");
    const search = screen.getByLabelText(/Search expenses/i);
    await userEvent.type(search, "Vercel");
    expect(screen.queryByText("AWS")).not.toBeInTheDocument();
    expect(screen.getByText("Vercel")).toBeInTheDocument();
  });
});
