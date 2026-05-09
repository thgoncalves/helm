/**
 * SignOutButton — signs the user out of Cognito and clears the React Query
 * cache so no stale authenticated data lingers after sign-out.
 */
import { signOut } from "aws-amplify/auth";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function handleSignOut() {
    try {
      await signOut();
      queryClient.clear();
      navigate("/sign-in", { replace: true });
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void handleSignOut()}>
      Sign out
    </Button>
  );
}
