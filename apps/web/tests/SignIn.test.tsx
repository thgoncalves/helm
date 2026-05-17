/**
 * Tests for src/routes/SignIn.tsx
 *
 * Most of the form mechanics now belong to @aws-amplify/ui-react's
 * <Authenticator>, so the contract worth covering at this layer is:
 *
 * - The Helm brand header is rendered.
 * - We navigate to /account-type once authStatus flips to "authenticated".
 *
 * The Authenticator itself is mocked here because exercising it
 * meaningfully requires a real Cognito pool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockUseAuthenticator = vi.fn();
vi.mock("@aws-amplify/ui-react", () => ({
  Authenticator: ({
    components,
    children,
  }: {
    components?: { Header?: () => React.ReactElement };
    children?: (props: unknown) => React.ReactElement;
  }) => (
    <div data-testid="authenticator">
      {components?.Header?.()}
      <div>Sign-in form</div>
      {children?.({})}
    </div>
  ),
  useAuthenticator: (
    selector?: (ctx: { authStatus: string }) => unknown,
  ) => {
    const ctx = mockUseAuthenticator();
    if (selector) selector(ctx);
    return ctx;
  },
}));

import { SignIn } from "@/routes/SignIn";

function renderSignIn() {
  return render(
    <MemoryRouter>
      <SignIn />
    </MemoryRouter>,
  );
}

describe("SignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Helm brand header above the Authenticator", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "unauthenticated" });
    renderSignIn();

    expect(screen.getByText("Helm")).toBeInTheDocument();
    expect(screen.getByTestId("authenticator")).toBeInTheDocument();
  });

  it("navigates to /account-type when authStatus becomes authenticated", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "authenticated" });
    renderSignIn();

    expect(mockNavigate).toHaveBeenCalledWith("/account-type", {
      replace: true,
    });
  });

  it("does not navigate while unauthenticated", () => {
    mockUseAuthenticator.mockReturnValue({ authStatus: "unauthenticated" });
    renderSignIn();

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
