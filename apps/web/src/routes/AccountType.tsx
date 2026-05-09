import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { HelmIcon } from "@/components/HelmIcon";
import {
  AccountTypeToggle,
  type AccountType as AccountTypeValue,
} from "@/components/AccountTypeToggle";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * AccountType — the post-sign-in chooser. User picks Personal or Business
 * via the toggle, then clicks Continue to land on the appropriate dashboard.
 */
export function AccountType() {
  const navigate = useNavigate();
  const [value, setValue] = useState<AccountTypeValue>("personal");

  function handleContinue() {
    navigate(value === "personal" ? "/personal" : "/business", {
      replace: true,
    });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-8 flex flex-col items-center">
        <HelmIcon
          className="h-14 w-14 text-foreground"
          aria-hidden="true"
        />
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Helm</h1>
      </div>

      <div className="w-full max-w-sm space-y-6 text-center">
        <h2 className="text-xl font-semibold">Where would you like to go?</h2>
        <p className="text-sm text-muted-foreground">
          Pick the side of Helm you want to open. You can switch any time.
        </p>

        <div className="flex justify-center">
          <AccountTypeToggle value={value} onChange={setValue} />
        </div>

        <Button size="lg" className="w-full" onClick={handleContinue}>
          Continue
        </Button>

        <div className="pt-2">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
