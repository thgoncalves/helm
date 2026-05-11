/**
 * AppHeader — shared top header used by every protected route.
 *
 * Renders the Helm brand mark (logo + wordmark), a primary nav, and the
 * SignOutButton. The active nav item is derived from the current URL
 * (via `useLocation`) so individual routes don't have to hand-set it.
 *
 * Personal / Business split
 * -------------------------
 * Helm has two sides: Business (the legacy contractor app — Dashboard,
 * Clients, Invoices, etc.) and Personal (Accounts, Imports, Transactions,
 * Budgets-soon). To keep the mobile tab strip from blowing up to 12+ items
 * we drive context from the URL:
 *
 *   - Any path starting with `/personal/...`  → Personal nav (3 tabs).
 *   - Everything else                          → Business nav (9 tabs).
 *
 * A compact `Personal ⇄ Business` switcher sits to the left of Sign Out
 * so the user can flip sides without going back to `/account-type`. The
 * switcher always jumps to the section's landing route (`/dashboard` for
 * Business, `/personal/accounts` for Personal).
 *
 * Visual decisions:
 * - HelmIcon (SVG, single-color via `currentColor`) sits to the left of
 *   the "Helm" wordmark. The icon picks up `text-primary` so it always
 *   has an accent colour on every theme.
 * - Active tab uses a `text-foreground` color plus a 2px bottom border in
 *   `border-primary`. Inactive tabs get `text-muted-foreground` and a
 *   transparent border so layout doesn't shift on activation.
 * - The Personal/Business switcher uses the same pill/segmented style as
 *   the post-sign-in chooser but smaller — visually links the two.
 * - Wrapper uses `bg-background/95 backdrop-blur` so it reads as a real
 *   chrome bar without committing to a hard solid color.
 * - Single max-width (`max-w-6xl`) so the brand+nav land in the same
 *   spot regardless of which page's body is `max-w-3xl`/`5xl`/`6xl`.
 * - The nav scrolls horizontally on narrow viewports (`overflow-x-auto`)
 *   so the links remain reachable on mobile without wrapping.
 *
 * All colors are semantic shadcn tokens so Catppuccin Mocha and
 * Tokyo Night work without per-page overrides.
 */
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HelmIcon } from "@/components/HelmIcon";
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

const BUSINESS_NAV: readonly NavItem[] = [
  { to: "/dashboard", label: "Dashboard", matchPrefixes: ["/dashboard"] },
  { to: "/clients", label: "Clients", matchPrefixes: ["/clients"] },
  { to: "/timesheets", label: "Timesheets", matchPrefixes: ["/timesheets"] },
  { to: "/invoices", label: "Invoices", matchPrefixes: ["/invoices"] },
  { to: "/payments", label: "Payments", matchPrefixes: ["/payments"] },
  { to: "/expenses", label: "Expenses", matchPrefixes: ["/expenses"] },
  { to: "/taxes", label: "Taxes", matchPrefixes: ["/taxes"] },
  { to: "/transfers", label: "Transfers", matchPrefixes: ["/transfers"] },
  { to: "/settings", label: "Settings", matchPrefixes: ["/settings"] },
] as const;

const PERSONAL_NAV: readonly NavItem[] = [
  {
    to: "/personal/accounts",
    label: "Accounts",
    matchPrefixes: ["/personal/accounts"],
  },
  {
    to: "/personal/imports",
    label: "Imports",
    matchPrefixes: ["/personal/imports"],
  },
  {
    to: "/personal/transactions",
    label: "Transactions",
    matchPrefixes: ["/personal/transactions"],
  },
] as const;

/** Landing route for each side; used by the in-header switcher. */
const BUSINESS_HOME = "/dashboard";
const PERSONAL_HOME = "/personal/accounts";

type Side = "business" | "personal";

/**
 * Returns true if the current pathname falls under any of `prefixes`.
 * A prefix matches when pathname equals it OR starts with `${prefix}/`.
 */
function isActive(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Pick the active side from the URL. Personal lives under /personal/*. */
function sideForPath(pathname: string): Side {
  return pathname === "/personal" || pathname.startsWith("/personal/")
    ? "personal"
    : "business";
}

export function AppHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const side = sideForPath(pathname);
  const items = side === "personal" ? PERSONAL_NAV : BUSINESS_NAV;
  const brandHome = side === "personal" ? PERSONAL_HOME : BUSINESS_HOME;

  function switchSide(next: Side) {
    if (next === side) return;
    navigate(next === "personal" ? PERSONAL_HOME : BUSINESS_HOME);
  }

  // The Business nav has 9 tabs and reliably overflows on mobile (and on
  // iPad once the side cluster steals room), so it gets a right-edge fade
  // mask to advertise the scroll affordance. The Personal nav has only 3
  // tabs that fit at every supported viewport, so the mask would just
  // clip "Transactions" for no benefit.
  const navMask =
    side === "business"
      ? "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
      : "";

  const tabs = (
    <nav
      className={cn(
        "-mb-3 flex gap-1 overflow-x-auto text-sm sm:gap-2",
        navMask,
      )}
      aria-label="Primary"
    >
      {items.map((item) => {
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
  );

  return (
    <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {/* Row 1 on mobile / left cluster on desktop: brand + Side switcher
            + Sign out. Putting the switcher next to the brand on mobile
            frees the second row for the tab strip so the 9 Business tabs
            stay reachable on a 393px viewport. */}
        <div className="flex items-center justify-between gap-3 sm:min-w-0 sm:flex-1 sm:justify-start sm:gap-6">
          <Link
            to={brandHome}
            className="flex shrink-0 items-center gap-2 text-foreground"
            aria-label="Helm home"
          >
            <HelmIcon className="h-7 w-7 text-primary" />
            <span className="text-lg font-semibold tracking-tight">Helm</span>
          </Link>
          {/* Desktop: tabs sit between brand and the right-side controls. */}
          <div className="hidden min-w-0 flex-1 sm:flex">{tabs}</div>
          {/* Mobile-only side switcher + sign out. On desktop these move
              to the dedicated right-side cluster below. */}
          <div className="flex shrink-0 items-center gap-2 sm:hidden">
            <SideSwitcher side={side} onSwitch={switchSide} />
            <SignOutButton />
          </div>
        </div>

        {/* Row 2 on mobile: tab strip gets its own line so it can scroll
            edge-to-edge without competing with the brand/switcher row. */}
        <div className="sm:hidden">{tabs}</div>

        {/* Desktop-only right cluster. */}
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <SideSwitcher side={side} onSwitch={switchSide} />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

/**
 * Compact two-position pill that switches between the Business and Personal
 * sides of the app. Lives in the header's top-right cluster.
 */
function SideSwitcher({
  side,
  onSwitch,
}: {
  side: Side;
  onSwitch: (next: Side) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="App section"
      className="inline-flex shrink-0 items-center rounded-full bg-muted p-0.5 text-xs"
    >
      <SideButton
        active={side === "business"}
        onClick={() => onSwitch("business")}
      >
        Business
      </SideButton>
      <SideButton
        active={side === "personal"}
        onClick={() => onSwitch("personal")}
      >
        Personal
      </SideButton>
    </div>
  );
}

function SideButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
