/**
 * Tests for src/components/ProtectedRoute.tsx
 *
 * Covers:
 * - Redirects to / (the public sign-in page) when no authenticated user.
 * - Renders child routes when a user is authenticated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { getCurrentUser } from "aws-amplify/auth";
import { ProtectedRoute } from "@/components/ProtectedRoute";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithRoutes(initialPath = "/protected") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div>Sign In Page</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/protected" element={<div>Protected Content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProtectedRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to / when no user is authenticated", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(
      new Error("No current user"),
    );

    renderWithRoutes();

    await waitFor(() => {
      expect(screen.getByText("Sign In Page")).toBeInTheDocument();
    });
  });

  it("renders children when a user is authenticated", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      username: "test-user",
      userId: "test-id",
      signInDetails: undefined,
    });

    renderWithRoutes();

    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeInTheDocument();
    });
  });

  it("shows a loading state while the auth check is in flight", () => {
    // Never resolve — keeps the component in loading state
    vi.mocked(getCurrentUser).mockImplementation(
      () => new Promise(() => undefined),
    );

    renderWithRoutes();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
