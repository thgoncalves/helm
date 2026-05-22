/**
 * AppHeader — shared top header used by every protected route.
 *
 * Renders the Helm brand mark (logo + wordmark), a primary nav, the
 * 3-module switcher pill, and the SignOutButton. The active nav item is
 * derived from the current URL (via `useLocation`) so individual routes
 * don't have to hand-set it.
 *
 * Module model
 * ------------
 * Helm has three peer modules. The current module is derived from the URL
 * prefix so individual screens don't have to hand-set it:
 *
 *   - /money/...        → Money       (YNAB-driven personal cash flow)
 *   - /investments/...  → Investments (portfolio tracking — V1 placeholder)
 *   - everything else   → Business    (the legacy contractor app)
 *
 * The header's `ModuleSwitcher` is a 3-segment pill that jumps to the
 * landing route of each module. It also persists the choice in
 * `localStorage["helm:lastModule"]` so the post-sign-in chooser can fast-
 * forward returning users to the last module they used.
 *
 * Visual decisions:
 * - HelmIcon (SVG, single-color via `currentColor`) sits to the left of
 *   the "Helm" wordmark. The icon picks up `text-primary` so it always
 *   has an accent colour on every theme.
 * - Active tab uses a `text-foreground` color plus a 2px bottom border in
 *   `border-primary`. Inactive tabs get `text-muted-foreground` and a
 *   transparent border so layout doesn't shift on activation.
 * - The switcher uses the same pill/segmented style as the post-sign-in
 *   chooser but smaller — visually links the two.
 * - Wrapper uses `bg-background/95 backdrop-blur` so it reads as a real
 *   chrome bar without committing to a hard solid color.
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
import { rememberModule, type ModuleId } from "@/lib/module";

interface NavItem {
  to: string;
  label: string;
  /**
   * Path prefixes that should also mark this nav item as active when
   * the pathname starts with them (i.e. `/clients/new` and
   * `/clients/:id` keep the "Clients" tab lit).
   */
  matchPrefixes: string[];
  /**
   * Path strings that should mark this nav item as active ONLY on exact
   * equality with the pathname. Used for parent landing tabs whose URL
   * is a prefix of sibling tabs' URLs — e.g. Investments "Overview"
   * matches `/investments` exactly so `/investments/accounts` doesn't
   * also light it up, while `matchPrefixes` still catches sub-tasks
   * launched from Overview (`/investments/holdings/new`, etc).
   */
  matchExact?: string[];
}

const BUSINESS_NAV: readonly NavItem[] = [
  { to: "/dashboard", label: "Dashboard", matchPrefixes: ["/dashboard"] },
  { to: "/timesheets", label: "Timesheets", matchPrefixes: ["/timesheets"] },
  { to: "/invoices", label: "Invoices", matchPrefixes: ["/invoices"] },
  { to: "/payments", label: "Payments", matchPrefixes: ["/payments"] },
  { to: "/expenses", label: "Expenses", matchPrefixes: ["/expenses"] },
  { to: "/taxes", label: "Taxes", matchPrefixes: ["/taxes"] },
  { to: "/transfers", label: "Transfers", matchPrefixes: ["/transfers"] },
  { to: "/clients", label: "Clients", matchPrefixes: ["/clients"] },
  // Settings is a global concern (Money's YNAB section, Business's
  // company/tax fields, future Investments preferences) — it lives in
  // the header's right cluster as a gear icon instead of as a Business
  // sub-tab.
] as const;

const MONEY_NAV: readonly NavItem[] = [
  {
    to: "/money/dashboard",
    label: "Dashboard",
    // matchExact keeps Dashboard from stealing the active state when
    // the user is on /accounts (also part of the Money module).
    matchExact: ["/money/dashboard", "/money"],
    matchPrefixes: [],
  },
  {
    to: "/accounts",
    label: "Accounts",
    matchPrefixes: ["/accounts"],
  },
] as const;

const INVESTMENTS_NAV: readonly NavItem[] = [
  {
    to: "/investments",
    label: "Overview",
    matchExact: ["/investments"],
    matchPrefixes: [],
  },
  {
    to: "/investments/stocks",
    label: "Stocks",
    matchPrefixes: ["/investments/stocks"],
  },
] as const;

/** Landing route for each module; used by the in-header switcher. */
const HOME: Record<ModuleId, string> = {
  business: "/dashboard",
  money: "/money/dashboard",
  investments: "/investments",
};

/**
 * Returns true if the current pathname matches any of the nav item's
 * configured matchers. `matchPrefixes` use startsWith; `matchExact` use
 * pathname equality. A NavItem can mix the two so a parent landing tab
 * stays lit through its task sub-pages without leaking into siblings.
 */
function isActive(pathname: string, item: NavItem): boolean {
  if (item.matchExact?.some((p) => pathname === p)) return true;
  return item.matchPrefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Pick the active module from the URL. */
function moduleForPath(pathname: string): ModuleId {
  if (pathname === "/money" || pathname.startsWith("/money/")) return "money";
  // /accounts is the unified Accounts page. It's cross-cutting in concept
  // but lives under the Money nav because that's where the user expects
  // "manage where my money lives."
  if (pathname === "/accounts" || pathname.startsWith("/accounts/"))
    return "money";
  if (pathname === "/investments" || pathname.startsWith("/investments/"))
    return "investments";
  return "business";
}

function navForModule(m: ModuleId): readonly NavItem[] {
  switch (m) {
    case "money":
      return MONEY_NAV;
    case "investments":
      return INVESTMENTS_NAV;
    default:
      return BUSINESS_NAV;
  }
}

export function AppHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mod = moduleForPath(pathname);
  const items = navForModule(mod);
  const brandHome = HOME[mod];

  function switchModule(next: ModuleId) {
    if (next === mod) return;
    rememberModule(next);
    navigate(HOME[next]);
  }

  // The Business nav has 9 tabs and reliably overflows on mobile (and on
  // iPad once the right cluster steals room), so it gets a right-edge fade
  // mask to advertise the scroll affordance. Money + Investments each have
  // a single tab today (more coming when those modules grow); the mask
  // would just clip "Overview"/"Dashboard" for no benefit.
  const navMask =
    mod === "business"
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
        const active = isActive(pathname, item);
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
        {/* Row 1 on mobile / left cluster on desktop: brand + module
            switcher + Sign out. Putting the switcher next to the brand on
            mobile frees the second row for the tab strip so the 9 Business
            tabs stay reachable on a 393px viewport. */}
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
          {/* Mobile-only module switcher + settings + sign out. On
              desktop these move to the dedicated right-side cluster
              below. */}
          <div className="flex shrink-0 items-center gap-2 sm:hidden">
            <ModuleSwitcher current={mod} onSwitch={switchModule} />
            <SettingsButton pathname={pathname} />
            <SignOutButton />
          </div>
        </div>

        {/* Row 2 on mobile: tab strip gets its own line so it can scroll
            edge-to-edge without competing with the brand/switcher row. */}
        <div className="sm:hidden">{tabs}</div>

        {/* Desktop-only right cluster. */}
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <ModuleSwitcher current={mod} onSwitch={switchModule} />
          <SettingsButton pathname={pathname} />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

/**
 * Settings gear — lives in the header's right cluster so every module
 * can reach the (shared) Settings page without taking up tab real-estate.
 * The icon flips to "active" styling when the user is already on the
 * Settings route.
 */
function SettingsButton({ pathname }: { pathname: string }) {
  const active = pathname === "/settings" || pathname.startsWith("/settings/");
  return (
    <Link
      to="/settings"
      aria-label="Settings"
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </Link>
  );
}

/**
 * Compact three-position pill that switches between Helm's modules.
 * Lives in the header's top-right cluster. The label `Money` is
 * intentionally short so the pill stays compact on iPhone 12-class
 * widths; `Investing` uses an abbreviated label for the same reason.
 */
function ModuleSwitcher({
  current,
  onSwitch,
}: {
  current: ModuleId;
  onSwitch: (next: ModuleId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="App module"
      className="inline-flex shrink-0 items-center rounded-full bg-muted p-0.5 text-xs"
    >
      <ModuleButton
        active={current === "business"}
        onClick={() => onSwitch("business")}
      >
        Business
      </ModuleButton>
      <ModuleButton
        active={current === "money"}
        onClick={() => onSwitch("money")}
      >
        Money
      </ModuleButton>
      <ModuleButton
        active={current === "investments"}
        onClick={() => onSwitch("investments")}
      >
        Investing
      </ModuleButton>
    </div>
  );
}

function ModuleButton({
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
