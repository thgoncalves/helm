import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { HelmIcon } from "@/components/HelmIcon";
import {
  AccountTypeToggle,
  type AccountType,
} from "@/components/AccountTypeToggle";

/**
 * Public landing page at `/`. Brand mark + tagline + Personal/Business
 * toggle + sign-in CTA. Authenticated users can navigate straight to
 * `/clients` from here.
 */
export function Landing() {
  const [accountType, setAccountType] = useState<AccountType>("personal");

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto flex max-w-2xl flex-col items-center px-6 py-20 text-center">
        <HelmIcon
          className="h-32 w-32 text-foreground"
          aria-hidden="true"
        />

        <h1 className="mt-8 text-5xl font-bold tracking-tight">Helm</h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Your financial command center.
        </p>

        <div className="mt-10">
          <AccountTypeToggle value={accountType} onChange={setAccountType} />
        </div>

        <Button asChild size="lg" className="mt-10">
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
