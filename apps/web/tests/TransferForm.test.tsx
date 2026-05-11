/**
 * Tests for src/routes/TransferForm.tsx (NewTransfer).
 *
 * Focus: auto-estimate recompute, manual override path when checkbox is
 * cleared, and total live math.
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

import { NewTransfer } from "@/routes/TransferForm";

function setupApi() {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/business/transfers/tax-rates") {
      return { company_rate: "0.30", personal_rate: "0.325" };
    }
    throw new Error(`Unhandled: ${path}`);
  });
}

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/transfers/new"]}>
        <Routes>
          <Route path="/transfers/new" element={<NewTransfer />} />
          <Route path="/transfers" element={<div>Landing</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TransferForm (NewTransfer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApi();
  });

  it("auto-estimates company / personal tax from the amount", async () => {
    renderForm();
    const amount = await screen.findByLabelText(/Amount \*/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, "2000");

    await waitFor(() => {
      const company = screen.getByLabelText(/Company Tax/) as HTMLInputElement;
      const personal = screen.getByLabelText(/Personal Tax/) as HTMLInputElement;
      expect(company.value).toBe("600.00");
      expect(personal.value).toBe("650.00");
      expect(company.disabled).toBe(true);
      expect(personal.disabled).toBe(true);
    });

    // Total = 600 + 650 = 1250.
    expect(
      screen.getByText("Total Estimated Tax").nextElementSibling?.textContent,
    ).toMatch(/\$1,250\.00/);
  });

  it("unchecking auto-estimate unlocks the manual fields", async () => {
    renderForm();
    const amount = await screen.findByLabelText(/Amount \*/i);
    await userEvent.clear(amount);
    await userEvent.type(amount, "2000");
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/Company Tax/) as HTMLInputElement).value,
      ).toBe("600.00");
    });

    await userEvent.click(screen.getByLabelText(/Auto-estimate taxes/i));
    const company = screen.getByLabelText(/Company Tax/) as HTMLInputElement;
    expect(company.disabled).toBe(false);

    // Override the value — auto-estimate is off, so changes to amount
    // must not clobber it.
    await userEvent.clear(company);
    await userEvent.type(company, "100");
    await userEvent.clear(amount);
    await userEvent.type(amount, "5000");
    expect(company.value).toBe("100");
  });
});
