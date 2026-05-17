/**
 * Tests for src/routes/ClientForm.tsx
 *
 * Covers:
 * - NewClient renders all key fields.
 * - Zod validation fires on empty Name.
 * - NewClient calls POST on save and navigates on success.
 * - EditClient fetches the existing client and populates the form.
 * - EditClient calls PUT on save.
 * - Active/Archived toggle is present in edit mode only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewClient, EditClient } from "@/routes/ClientForm";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const EXISTING_CLIENT = {
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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderNewClient() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <NewClient />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderEditClient(id = "00000000-0000-0000-0000-000000000001") {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[`/clients/${id}/edit`]}>
        <Routes>
          <Route path="/clients/:id/edit" element={<EditClient />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NewClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders key form fields", () => {
    renderNewClient();
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/country/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tax id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/hourly rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/timesheet frequency/i)).toBeInTheDocument();
  });

  it("defaults country to Canada", () => {
    renderNewClient();
    const countryInput = screen.getByLabelText(/country/i) as HTMLInputElement;
    expect(countryInput.value).toBe("Canada");
  });

  it("does NOT render the Active/Archived toggle in create mode", () => {
    renderNewClient();
    expect(screen.queryByLabelText(/active \(uncheck to archive\)/i)).not.toBeInTheDocument();
  });

  it("shows validation error when Name is empty on submit", async () => {
    renderNewClient();

    const form = screen
      .getByRole("button", { name: /save/i })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    });
  });

  it("calls POST /business/clients/ on save with valid data", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({
      ...EXISTING_CLIENT,
      id: "new-uuid-1234",
      name: "New Corp",
    });

    renderNewClient();

    await user.type(screen.getByLabelText(/^name/i), "New Corp");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/business/clients/",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("navigates to /clients/:id on successful create", async () => {
    const user = userEvent.setup();
    const createdClient = { ...EXISTING_CLIENT, id: "brand-new-uuid" };
    vi.mocked(apiFetch).mockResolvedValue(createdClient);

    renderNewClient();

    await user.type(screen.getByLabelText(/^name/i), "New Corp");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        `/clients/${createdClient.id}`,
      );
    });
  });
});

describe("EditClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and populates the form with existing client data", async () => {
    vi.mocked(apiFetch).mockResolvedValue(EXISTING_CLIENT);

    renderEditClient();

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/^name/i) as HTMLInputElement;
      expect(nameInput.value).toBe("Sulpetro");
    });
  });

  it("renders the Active/Archived toggle in edit mode", async () => {
    vi.mocked(apiFetch).mockResolvedValue(EXISTING_CLIENT);

    renderEditClient();

    await waitFor(() => {
      expect(screen.getByLabelText(/active \(uncheck to archive\)/i)).toBeInTheDocument();
    });
  });

  it("calls PUT /business/clients/:id on save", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(EXISTING_CLIENT) // initial fetch
      .mockResolvedValueOnce({ ...EXISTING_CLIENT, name: "Sulpetro Updated" }); // PUT

    renderEditClient();

    await waitFor(() => {
      const nameInput = screen.getByLabelText(/^name/i) as HTMLInputElement;
      expect(nameInput.value).toBe("Sulpetro");
    });

    // Clear name and type new value
    const nameInput = screen.getByLabelText(/^name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Sulpetro Updated");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining("/business/clients/"),
        expect.objectContaining({ method: "PUT" }),
      );
    });
  });

  it("navigates to /clients/:id on successful update", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(EXISTING_CLIENT)
      .mockResolvedValueOnce({ ...EXISTING_CLIENT, name: "Sulpetro Updated" });

    renderEditClient();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/^name/i),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        `/clients/${EXISTING_CLIENT.id}`,
      );
    });
  });
});
