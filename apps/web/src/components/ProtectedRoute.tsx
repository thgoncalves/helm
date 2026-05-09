/**
 * ProtectedRoute — wraps routes that require an authenticated session.
 *
 * Reads `authStatus` from the Amplify Authenticator context (provided at
 * the app root in main.tsx). The state machine is the source of truth, so
 * we don't need to roll our own getCurrentUser() polling.
 *
 *   configuring     → still resolving the cached session; show loading
 *   authenticated   → render children
 *   unauthenticated → redirect to / (the public sign-in page)
 */
import { Navigate, Outlet } from "react-router-dom";
import { useAuthenticator } from "@aws-amplify/ui-react";

export function ProtectedRoute() {
  const { authStatus } = useAuthenticator((c) => [c.authStatus]);

  if (authStatus === "configuring") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (authStatus !== "authenticated") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
