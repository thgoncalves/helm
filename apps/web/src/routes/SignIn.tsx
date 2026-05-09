/**
 * SignIn page — handles two flows:
 *
 * 1. Normal sign-in: email + password → redirect to /clients on success.
 * 2. FORCE_CHANGE_PASSWORD challenge: Cognito admin-created users must set a
 *    new password on first sign-in. When signIn returns
 *    `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED` we render a second form and
 *    call confirmSignIn with the new password.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signIn, confirmSignIn } from "aws-amplify/auth";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HelmIcon } from "@/components/HelmIcon";

function BrandMark() {
  return (
    <div className="mb-6 flex flex-col items-center">
      <HelmIcon
        className="h-14 w-14 text-foreground"
        aria-hidden="true"
      />
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Helm</h1>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const signInSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const newPasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[a-z]/, "Must contain a lowercase letter")
      .regex(/[0-9]/, "Must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SignInFormValues = z.infer<typeof signInSchema>;
type NewPasswordFormValues = z.infer<typeof newPasswordSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SignIn() {
  const navigate = useNavigate();
  const [challenge, setChallenge] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Sign-in form
  const signInForm = useForm<SignInFormValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });

  // New-password form (shown after FORCE_CHANGE_PASSWORD challenge)
  const newPasswordForm = useForm<NewPasswordFormValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  async function handleSignIn(values: SignInFormValues) {
    setServerError(null);
    try {
      const result = await signIn({
        username: values.email,
        password: values.password,
      });

      if (
        result.nextStep.signInStep ===
        "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
      ) {
        setChallenge(true);
        return;
      }

      if (result.isSignedIn) {
        navigate("/account-type", { replace: true });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Sign-in failed. Please try again.";
      setServerError(message);
    }
  }

  async function handleNewPassword(values: NewPasswordFormValues) {
    setServerError(null);
    try {
      const result = await confirmSignIn({
        challengeResponse: values.newPassword,
      });

      if (result.isSignedIn) {
        navigate("/account-type", { replace: true });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to set new password.";
      setServerError(message);
    }
  }

  // ---------------------------------------------------------------------------
  // New-password challenge view
  // ---------------------------------------------------------------------------

  if (challenge) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
        <BrandMark />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Set a new password</CardTitle>
            <CardDescription>
              Your account requires a new password before you can continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={newPasswordForm.handleSubmit((v) =>
                void handleNewPassword(v),
              )}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  {...newPasswordForm.register("newPassword")}
                />
                {newPasswordForm.formState.errors.newPassword && (
                  <p className="text-sm text-destructive">
                    {newPasswordForm.formState.errors.newPassword.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  {...newPasswordForm.register("confirmPassword")}
                />
                {newPasswordForm.formState.errors.confirmPassword && (
                  <p className="text-sm text-destructive">
                    {newPasswordForm.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>

              {serverError && (
                <p className="text-sm text-destructive">{serverError}</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={newPasswordForm.formState.isSubmitting}
              >
                {newPasswordForm.formState.isSubmitting
                  ? "Updating…"
                  : "Set password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // Normal sign-in view
  // ---------------------------------------------------------------------------

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <BrandMark />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Enter your email and password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={signInForm.handleSubmit((v) => void handleSignIn(v))}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...signInForm.register("email")}
              />
              {signInForm.formState.errors.email && (
                <p className="text-sm text-destructive">
                  {signInForm.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                {...signInForm.register("password")}
              />
              {signInForm.formState.errors.password && (
                <p className="text-sm text-destructive">
                  {signInForm.formState.errors.password.message}
                </p>
              )}
            </div>

            {serverError && (
              <p className="text-sm text-destructive">{serverError}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={signInForm.formState.isSubmitting}
            >
              {signInForm.formState.isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
