/**
 * Tests for src/routes/PersonalAccounts.tsx.
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

import { PersonalAccounts } from "@/routes/PersonalAccounts";

function makeAccount(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "acc-" + (over.id ?? "1"),
    name: "RBC Chequing",
    institution: "RBC",
    account_type: "checking",
    currency: "CAD",
    opening_balance: "0",
    is_active: true,
    notes: null,
    created_at: "2026-05-10T00:00:00Z",
    updated_at: "2026-05-10T00:00:00Z",
    ...over,
  };
}

function setupApi(rows: ReturnType<typeof makeAccount>[]) {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/personal/accounts/") && (!init || init.method === undefined)) {
      return rows;
    }
    if (path === "/personal/accounts/" && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const created = makeAccount({ id: "new-1", ...body });
      rows.push(created);
      return created;
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
      <MemoryRouter>
        <PersonalAccounts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PersonalAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders account rows", async () => {
    setupApi([
      makeAccount({ id: "1", name: "RBC Chequing", institution: "RBC" }),
      makeAccount({ id: "2", name: "TD Visa", institution: "TD", account_type: "credit_card" }),
    ]);
    renderPage();
    expect(await screen.findByText("RBC Chequing")).toBeInTheDocument();
    expect(screen.getByText("TD Visa")).toBeInTheDocument();
  });

  it("New Account opens the form and creates a row", async () => {
    setupApi([]);
    renderPage();
    await screen.findByText(/No accounts yet/);
    await userEvent.click(
      screen.getByRole("button", { name: /New Account/ }),
    );
    const name = (await screen.findByLabelText(/^Name$/)) as HTMLInputElement;
    await userEvent.type(name, "Scotia Savings");

    const select = screen.getByLabelText(/Institution/) as HTMLSelectElement;
    await userEvent.selectOptions(select, "Scotia");

    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const post = apiFetchMock.mock.calls.find(
        (c) =>
          c[0] === "/personal/accounts/" &&
          (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.name).toBe("Scotia Savings");
      expect(body.institution).toBe("Scotia");
    });
  });
});
