/**
 * Tests for src/routes/Settings.tsx.
 *
 * The page now uses per-section Save buttons instead of a single "Save Settings"
 * button. Each section renders a button labelled "save" within its own <section>.
 * Theme is selected via ThemeCard buttons (aria-pressed), not a <select>.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

import { Settings } from "@/routes/Settings";

const SEED = {
  company_name: "2441735 ALBERTA INC.",
  gst_rate: "0.0500",
  transfer_tax_rate_company: "0.30",
  transfer_tax_rate_personal: "0.325",
  invoice_number_prefix: "INV",
  default_payment_terms: "Net 30",
  default_currency: "CAD",
  user_full_name: "Thiago Gonçalves Pinto",
  user_email: "th.goncalves@gmail.com",
  etransfer_email: "th.go.pinto@gmail.com",
  theme: "default",
};

function setupApi(initial = SEED) {
  let current = { ...initial };
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/business/settings/" && (!init || init.method === undefined)) {
      return current;
    }
    if (path === "/business/settings/" && init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      current = { ...current, ...body };
      return current;
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
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.className = "";
    window.localStorage.clear();
    setupApi();
  });

  it("hydrates form fields from the API and shows tax rates as %", async () => {
    renderPage();
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/Company Name/i) as HTMLInputElement).value,
      ).toBe("2441735 ALBERTA INC.");
    });
    expect((screen.getByLabelText(/^GST Rate/i) as HTMLInputElement).value).toBe(
      "5.0%",
    );
    expect(
      (screen.getByLabelText(/Company Tax Rate \(Transfers\)/i) as HTMLInputElement)
        .value,
    ).toBe("30.0%");
    expect(
      (screen.getByLabelText(/Personal Tax Rate \(Transfers\)/i) as HTMLInputElement)
        .value,
    ).toBe("32.5%");
  });

  it("Company save button is disabled until something changes", async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for the Company section to appear
    await screen.findByLabelText(/Company Name/i);
    const companySection = document.getElementById("company")!;
    const save = within(companySection).getByRole("button", { name: /^save$/i });
    await waitFor(() => expect(save).toBeDisabled());

    const name = screen.getByLabelText(/Company Name/i);
    await user.type(name, " (Updated)");
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  it("PUT body contains only the changed keys (Invoice section save)", async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for the page to hydrate
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/Invoice Number Prefix/i) as HTMLInputElement).value,
      ).toBe("INV"),
    );

    const prefix = screen.getByLabelText(/Invoice Number Prefix/i);
    // triple-click to select all text, then type replaces it
    await user.tripleClick(prefix);
    await user.keyboard("BILL");

    // Wait for the save button to become enabled (dirty state)
    const saveBtn = await waitFor(() => {
      const invoicesSection = document.getElementById("invoices")!;
      const btn = within(invoicesSection).getByRole("button", { name: /^save$/i });
      expect(btn).not.toBeDisabled();
      return btn;
    });
    await user.click(saveBtn);

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      // Only the prefix changed.
      expect(Object.keys(body)).toEqual(["invoice_number_prefix"]);
      expect(body.invoice_number_prefix).toBe("BILL");
    });
  });

  it("selecting a ThemeCard applies the class immediately", async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for the theme cards to render
    const catppuccin = await screen.findByRole("button", {
      name: /Select Catppuccin/i,
    });
    await user.click(catppuccin);
    expect(
      document.documentElement.classList.contains("theme-catppuccin"),
    ).toBe(true);

    const tokyoNight = screen.getByRole("button", {
      name: /Select Tokyo Night/i,
    });
    await user.click(tokyoNight);
    expect(
      document.documentElement.classList.contains("theme-tokyo-night"),
    ).toBe(true);
    expect(
      document.documentElement.classList.contains("theme-catppuccin"),
    ).toBe(false);
  });

  it("entering a percent value converts to the decimal sent to the server", async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for page to hydrate with the seeded GST rate
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/^GST Rate/i) as HTMLInputElement).value,
      ).toBe("5.0%"),
    );

    const gst = screen.getByLabelText(/^GST Rate/i);
    // triple-click selects all, then keyboard replaces it
    await user.tripleClick(gst);
    await user.keyboard("13%");

    // Wait for the save button to become enabled (dirty state)
    const saveBtn = await waitFor(() => {
      const taxesSection = document.getElementById("taxes")!;
      const btn = within(taxesSection).getByRole("button", { name: /^save$/i });
      expect(btn).not.toBeDisabled();
      return btn;
    });
    await user.click(saveBtn);

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.gst_rate).toBe("0.13");
    });
  });
});
