import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * Personal dashboard placeholder. Real content (budgets, transactions,
 * investments) lands in V2.
 */
export function Personal() {
  return (
    <main className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-semibold">Helm — Personal</h1>
          <SignOutButton />
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h2 className="text-2xl font-bold">Personal — coming soon</h2>
        <p className="mt-3 text-muted-foreground">
          Budgeting, transactions, and investments live here.
        </p>
        <div className="mt-6">
          <Button asChild variant="outline">
            <Link to="/account-type">Back</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
