/**
 * AppHeader — shared top header used by every protected route.
 *
 * Renders the Helm brand mark (logo + wordmark), a primary nav, and the
 * SignOutButton. The active nav item is derived from the current URL
 * (via `useLocation`) so individual routes don't have to hand-set it.
 *
 * Visual decisions:
 * - Logo (`/helm_logo.png`) sits to the left of the "Helm" wordmark.
 * - Active tab uses a `text-primary` color plus a 2px bottom border in
 *   `border-primary`. Inactive tabs get `text-muted-foreground` and a
 *   transparent border so layout doesn't shift on activation.
 * - Wrapper uses `bg-background/95 backdrop-blur` so it reads as a real
 *   chrome bar without committing to a hard solid color (works for both
 *   light and dark themes).
 * - Single max-width (`max-w-6xl`) so the brand+nav land in the same
 *   spot regardless of which page's body is `max-w-3xl`/`5xl`/`6xl`.
 * - The nav scrolls horizontally on narrow viewports (`overflow-x-auto`)
 *   so the 7 links remain reachable on mobile without wrapping.
 *
 * All colors are semantic shadcn tokens so Catppuccin Mocha and
 * Tokyo Night work without per-page overrides.
 */
import { Link, useLocation } from "react-router-dom";
import { SignOutButton } from "@/components/SignOutButton";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  /**
   * Path prefixes that should also mark this nav item as active. For
   * example, `/clients/new` and `/clients/:id` should keep the "Clients"
   * tab lit.
   */
  matchPrefixes: string[];
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/clients", label: "Clients", matchPrefixes: ["/clients"] },
  { to: "/timesheets", label: "Timesheets", matchPrefixes: ["/timesheets"] },
  { to: "/invoices", label: "Invoices", matchPrefixes: ["/invoices"] },
  { to: "/payments", label: "Payments", matchPrefixes: ["/payments"] },
  { to: "/taxes", label: "Taxes", matchPrefixes: ["/taxes"] },
  { to: "/transfers", label: "Transfers", matchPrefixes: ["/transfers"] },
  { to: "/settings", label: "Settings", matchPrefixes: ["/settings"] },
] as const;

/**
 * Returns true if the current pathname falls under any of `prefixes`.
 * A prefix matches when pathname equals it OR starts with `${prefix}/`.
 */
function isActive(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function AppHeader() {
  const { pathname } = useLocation();

  return (
    <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-6">
          <Link
            to="/clients"
            className="flex shrink-0 items-center gap-2"
            aria-label="Helm home"
          >
            <img
              src="/helm_logo.png"
              alt=""
              className="h-7 w-7"
              aria-hidden="true"
            />
            <span className="text-lg font-semibold tracking-tight text-foreground">
              Helm
            </span>
          </Link>
          <nav
            className="-mb-3 flex gap-1 overflow-x-auto text-sm sm:gap-2"
            aria-label="Primary"
          >
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.matchPrefixes);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    // Layout: bottom-aligned tabs with a 2px indicator that
                    // doesn't shift content when toggling (transparent when
                    // inactive).
                    "shrink-0 border-b-2 px-2 pb-3 pt-1 font-medium transition-colors",
                    active
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
