/**
 * SignOutButton — uses the Authenticator's signOut so its state machine
 * flips authStatus, which causes ProtectedRoute (also wired to the
 * Authenticator context) to redirect on the next render. Also clears the
 * React Query cache so no stale authenticated data lingers.
 */
import { useAuthenticator } from "@aws-amplify/ui-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const { signOut } = useAuthenticator((c) => [c.signOut]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function handleSignOut() {
    signOut();
    queryClient.clear();
    navigate("/", { replace: true });
  }

  return (
    <Button variant="outline" size="sm" onClick={handleSignOut}>
      Sign out
    </Button>
  );
}
