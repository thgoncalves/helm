/**
 * SignIn page — wraps Amplify's <Authenticator> so we get sign-in,
 * forgot-password, and the FORCE_CHANGE_PASSWORD challenge for free, plus
 * automatic recovery from stale-session edge cases (e.g. tokens left over
 * from a different Cognito pool).
 *
 * The custom <Header> component renders the Helm brand mark; the rest of
 * the form is themed via amplify-theme.css to match shadcn.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";

import { HelmIcon } from "@/components/HelmIcon";

function Header() {
  return (
    <div className="mb-6 flex flex-col items-center">
      <HelmIcon className="h-14 w-14 text-foreground" aria-hidden="true" />
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Helm</h1>
    </div>
  );
}

export function SignIn() {
  const navigate = useNavigate();
  const { authStatus } = useAuthenticator((c) => [c.authStatus]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      navigate("/account-type", { replace: true });
    }
  }, [authStatus, navigate]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <Authenticator hideSignUp components={{ Header }}>
          {/* Render nothing on the post-sign-in flash — the useEffect above
              navigates to /account-type as soon as authStatus flips. */}
          {() => <></>}
        </Authenticator>
      </div>
    </main>
  );
}
