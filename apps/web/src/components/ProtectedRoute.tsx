/**
 * ProtectedRoute — wraps routes that require an authenticated session.
 *
 * On mount it calls getCurrentUser() from aws-amplify/auth. If the call
 * resolves (user is signed in) the children are rendered; if it rejects
 * (no session) the user is redirected to /sign-in.
 *
 * A loading state is shown while the async check is in flight to avoid
 * a flash of the protected content before the redirect.
 */
import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { getCurrentUser } from "aws-amplify/auth";

type AuthState = "loading" | "authenticated" | "unauthenticated";

export function ProtectedRoute() {
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    let cancelled = false;

    getCurrentUser()
      .then(() => {
        if (!cancelled) setAuthState("authenticated");
      })
      .catch(() => {
        if (!cancelled) setAuthState("unauthenticated");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <Navigate to="/sign-in" replace />;
  }

  return <Outlet />;
}
