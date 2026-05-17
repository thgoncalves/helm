/**
 * Tests for src/components/ProtectedRoute.tsx
 *
 * Verifies the Authenticator-context-driven gate:
 *   configuring     → loading view
 *   unauthenticated → redirect to /
 *   authenticated   → render the child <Outlet />
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mockUseAuthenticator = vi.fn();
vi.mock("@aws-amplify/ui-react", () => ({
  useAuthenticator: (
    selector?: (ctx: { authStatus: string }) => unknown,
  ) => {
    const ctx = mockUseAuthenticator();
    if (selector) selector(ctx);
    return ctx;
  },
}));

import { ProtectedRoute } from "@/components/ProtectedRoute";

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

describe("ProtectedRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to / when unauthenticated", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "unauthenticated" });
    renderWithRoutes();
    expect(screen.getByText("Sign In Page")).toBeInTheDocument();
  });

  it("renders children when authenticated", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "authenticated" });
    renderWithRoutes();
    expect(screen.getByText("Protected Content")).toBeInTheDocument();
  });

  it("shows a loading state while configuring", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "configuring" });
    renderWithRoutes();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
