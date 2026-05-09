/**
 * Tests for src/routes/SignIn.tsx
 *
 * Covers:
 * - Renders email and password fields.
 * - Zod validation fires on invalid input (empty fields, bad email).
 * - Calls signIn with correct shape on valid submission.
 * - Renders new-password form when CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED.
 * - Calls confirmSignIn with the new password.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { signIn, confirmSignIn } from "aws-amplify/auth";
import { SignIn } from "@/routes/SignIn";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSignIn() {
  return render(
    <MemoryRouter>
      <SignIn />
    </MemoryRouter>,
  );
}

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders email and password fields", () => {
    renderSignIn();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
  });

  it("shows validation error when email is invalid", async () => {
    renderSignIn();

    // Bypass native HTML email validation (jsdom honours it) by submitting
    // the form directly via fireEvent. An empty email fails z.string().email().
    const form = screen
      .getByRole("button", { name: /sign in/i })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        screen.getByText(/enter a valid email address/i),
      ).toBeInTheDocument();
    });
  });

  it("shows validation error when password is empty", async () => {
    const user = userEvent.setup();
    renderSignIn();

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    // Submit without a password via fireEvent to bypass native HTML validation
    const form = screen
      .getByRole("button", { name: /sign in/i })
      .closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    });
  });

  it("calls signIn with email and password on valid submission", async () => {
    const user = userEvent.setup();
    vi.mocked(signIn).mockResolvedValue({
      isSignedIn: true,
      nextStep: { signInStep: "DONE" },
    } as Awaited<ReturnType<typeof signIn>>);

    renderSignIn();

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "Password1");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({
        username: "user@example.com",
        password: "Password1",
      });
    });
  });

  it("renders new-password form when challenge is returned", async () => {
    const user = userEvent.setup();
    vi.mocked(signIn).mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED",
        missingAttributes: [],
      },
    } as Awaited<ReturnType<typeof signIn>>);

    renderSignIn();

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "TempPass1");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/set a new password/i)).toBeInTheDocument();
    });
  });

  it("calls confirmSignIn with the new password on challenge form submission", async () => {
    const user = userEvent.setup();

    vi.mocked(signIn).mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED",
        missingAttributes: [],
      },
    } as Awaited<ReturnType<typeof signIn>>);

    vi.mocked(confirmSignIn).mockResolvedValue({
      isSignedIn: true,
      nextStep: { signInStep: "DONE" },
    } as Awaited<ReturnType<typeof confirmSignIn>>);

    renderSignIn();

    // First sign in to trigger the challenge
    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(screen.getByLabelText(/password/i), "TempPass1");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // Wait for the new-password form
    await waitFor(() => {
      expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    });

    // Fill in the new password form
    await user.type(screen.getByLabelText(/^new password/i), "NewPass123");
    await user.type(screen.getByLabelText(/confirm password/i), "NewPass123");
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(confirmSignIn).toHaveBeenCalledWith({
        challengeResponse: "NewPass123",
      });
    });
  });
});
