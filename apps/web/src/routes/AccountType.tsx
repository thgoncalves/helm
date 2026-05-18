import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { HelmIcon } from "@/components/HelmIcon";
import { ModuleChooser } from "@/components/ModuleChooser";
import { SignOutButton } from "@/components/SignOutButton";
import {
  loadLastModule,
  rememberModule,
  type ModuleId,
} from "@/lib/module";

/**
 * AccountType — the post-sign-in chooser.
 *
 * Renders three large tiles for Business / Money / Investing. On submit
 * the chosen module is persisted to localStorage (`helm:lastModule`) so
 * returning users skip the chooser on the next sign-in — they land
 * directly on the module they last picked. The header's switcher writes
 * the same key, so deep-linked navigation stays sticky.
 *
 * The historical route name `/account-type` is preserved (still pointed
 * at by the post-sign-in flow) even though the underlying widget is now
 * a 3-module chooser instead of the 2-position toggle that lived here in
 * V1.
 */
const HOME_BY_MODULE: Record<ModuleId, string> = {
  business: "/dashboard",
  money: "/money/dashboard",
  investments: "/investments",
};

export function AccountType() {
  const navigate = useNavigate();

  // On first paint, check localStorage. If a previous choice exists,
  // fast-forward straight to that module so the user never sees the
  // chooser twice in a row. Use `replace` to keep the back button clean.
  useEffect(() => {
    const last = loadLastModule();
    if (last) {
      navigate(HOME_BY_MODULE[last], { replace: true });
    }
    // Run once on mount; intentionally no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [value, setValue] = useState<ModuleId>("money");

  function handleContinue() {
    rememberModule(value);
    navigate(HOME_BY_MODULE[value], { replace: true });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-8 flex flex-col items-center">
        <HelmIcon className="h-14 w-14 text-foreground" aria-hidden="true" />
        <h1 className="mt-2 text-2xl font-bold tracking-tight">Helm</h1>
      </div>

      <div className="w-full max-w-3xl space-y-6 text-center">
        <h2 className="text-xl font-semibold">Where would you like to go?</h2>
        <p className="text-sm text-muted-foreground">
          Pick the module you want to open. You can switch any time from the
          header.
        </p>

        <ModuleChooser value={value} onChoose={setValue} />

        <Button size="lg" className="w-full sm:w-auto" onClick={handleContinue}>
          Continue
        </Button>

        <div className="pt-2">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
