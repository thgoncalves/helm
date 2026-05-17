/**
 * Tests for src/routes/Clients.tsx
 *
 * Covers:
 * - Renders the list of active clients.
 * - "Show Archived" checkbox changes the query key (include_archived=true).
 * - Client-side search filters visible rows.
 * - Clicking a row navigates to /clients/:id.
 * - "New Client" button navigates to /clients/new.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Clients } from "@/routes/Clients";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock apiFetch so no real HTTP calls happen.
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
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

// Mock SignOutButton to keep tests simple.
vi.mock("@/components/SignOutButton", () => ({
  SignOutButton: () => <button>Sign out</button>,
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

import { apiFetch } from "@/lib/api";

const ACTIVE_CLIENTS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Sulpetro",
    email: "ckingsford@sulpetro.com",
    phone: "(403) 619-7785",
    city: "Calgary",
    state: "Alberta",
    country: "Canada",
    is_active: true,
    hourly_rate: "100.00",
    timesheet_frequency: "monthly",
    address_line1: null,
    address_line2: null,
    postal_code: null,
    tax_id: null,
    notes: null,
    created_at: "2022-03-01T09:00:00Z",
    updated_at: "2022-03-01T09:00:00Z",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Wenco",
    email: null,
    phone: null,
    city: null,
    state: null,
    country: "Canada",
    is_active: true,
    hourly_rate: "95.38",
    timesheet_frequency: "monthly",
    address_line1: null,
    address_line2: null,
    postal_code: null,
    tax_id: null,
    notes: null,
    created_at: "2022-03-01T09:00:00Z",
    updated_at: "2022-03-01T09:00:00Z",
  },
];

const ARCHIVED_CLIENT = {
  id: "00000000-0000-0000-0000-000000000003",
  name: "Nutrien",
  email: null,
  phone: null,
  city: null,
  state: null,
  country: "Canada",
  is_active: false,
  hourly_rate: null,
  timesheet_frequency: "monthly",
  address_line1: null,
  address_line2: null,
  postal_code: null,
  tax_id: null,
  notes: null,
  created_at: "2022-03-01T09:00:00Z",
  updated_at: "2022-03-01T09:00:00Z",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderClients() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Clients />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the list of active clients", async () => {
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);
    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });
    expect(screen.getByText("Wenco")).toBeInTheDocument();
    // Nutrien should not be visible (archived, not fetched in default mode)
    expect(screen.queryByText("Nutrien")).not.toBeInTheDocument();
  });

  it("passes include_archived=true when Show Archived is checked", async () => {
    const user = userEvent.setup();
    // First call: default (active only); second call: with include_archived
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ACTIVE_CLIENTS)
      .mockResolvedValueOnce([...ACTIVE_CLIENTS, ARCHIVED_CLIENT]);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    // Check "Show Archived"
    await user.click(screen.getByLabelText("Show Archived"));

    // The second apiFetch call should include ?include_archived=true
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining("include_archived=true"),
      );
    });
  });

  it("shows the archived client when Show Archived is checked", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ACTIVE_CLIENTS)
      .mockResolvedValueOnce([...ACTIVE_CLIENTS, ARCHIVED_CLIENT]);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Show Archived"));

    await waitFor(() => {
      expect(screen.getByText("Nutrien")).toBeInTheDocument();
    });
  });

  it("filters rows client-side when search text is entered", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(
      /search by name, email, or city/i,
    );
    await user.type(searchInput, "sulp");

    // Sulpetro should still be visible; Wenco should be hidden
    expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    expect(screen.queryByText("Wenco")).not.toBeInTheDocument();
  });

  it("Clear button empties the search input", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(
      /search by name, email, or city/i,
    );
    await user.type(searchInput, "sulp");
    await user.click(screen.getByRole("button", { name: /clear/i }));

    expect(searchInput).toHaveValue("");
    // Both clients visible again
    expect(screen.getByText("Wenco")).toBeInTheDocument();
  });

  it("navigates to /clients/:id when a row is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Sulpetro"));

    expect(mockNavigate).toHaveBeenCalledWith(
      `/clients/00000000-0000-0000-0000-000000000001`,
    );
  });

  it("navigates to /clients/new when New Client button is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);

    renderClients();

    await user.click(screen.getByRole("button", { name: /new client/i }));

    expect(mockNavigate).toHaveBeenCalledWith("/clients/new");
  });

  it("shows an empty state when no clients match the search", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue(ACTIVE_CLIENTS);

    renderClients();

    await waitFor(() => {
      expect(screen.getByText("Sulpetro")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(
      /search by name, email, or city/i,
    );
    await user.type(searchInput, "zzznomatchwhatever");

    expect(screen.getByText(/no clients found/i)).toBeInTheDocument();
  });
});
