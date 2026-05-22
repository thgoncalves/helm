/**
 * AppShell — fixed sidebar + scrollable main pane.
 *
 * Rendered as a layout route around every protected page in
 * ``App.tsx``. The body is locked to ``100dvh`` so the sidebar pins
 * and only the main pane (plus the sidebar's own nav, if it overflows)
 * scrolls. Spec: ``apps/web/public/prototypes/sidebar.html``.
 *
 * The sidebar consolidates all three modules' nav into one vertical
 * list with section headers — the old top-bar module switcher is gone.
 * Settings + Sign Out pin at the bottom in a footer separated by a
 * top border.
 */
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";

interface SidebarItem {
  to: string;
  label: string;
  /** Tabler Icons class suffix; rendered as ``ti ti-{icon}``. */
  icon: string;
  /** ``startsWith`` matches that also light this item. */
  matchPrefixes: string[];
  /** Exact pathnames that light this item (used for parent landings
   *  whose URL is a prefix of sibling items'). */
  matchExact?: string[];
}

interface SidebarSection {
  label: string;
  items: SidebarItem[];
}

const SECTIONS: readonly SidebarSection[] = [
  {
    label: "Business",
    items: [
      {
        to: "/dashboard",
        label: "Dashboard",
        icon: "layout-grid",
        matchPrefixes: ["/dashboard"],
      },
      {
        to: "/timesheets",
        label: "Timesheets",
        icon: "clock",
        matchPrefixes: ["/timesheets"],
      },
      {
        to: "/invoices",
        label: "Invoices",
        icon: "file-text",
        matchPrefixes: ["/invoices"],
      },
      {
        to: "/payments",
        label: "Payments",
        icon: "credit-card",
        matchPrefixes: ["/payments"],
      },
      {
        to: "/expenses",
        label: "Expenses",
        icon: "receipt-2",
        matchPrefixes: ["/expenses"],
      },
      {
        to: "/taxes",
        label: "Taxes",
        icon: "receipt-tax",
        matchPrefixes: ["/taxes"],
      },
      {
        to: "/transfers",
        label: "Transfers",
        icon: "arrows-left-right",
        matchPrefixes: ["/transfers"],
      },
      {
        to: "/clients",
        label: "Clients",
        icon: "users",
        matchPrefixes: ["/clients"],
      },
    ],
  },
  {
    label: "Money",
    items: [
      {
        to: "/money/dashboard",
        label: "Dashboard",
        icon: "layout-grid",
        matchExact: ["/money", "/money/dashboard"],
        matchPrefixes: [],
      },
      {
        to: "/accounts",
        label: "Accounts",
        icon: "wallet",
        matchPrefixes: ["/accounts"],
      },
    ],
  },
  {
    label: "Investing",
    items: [
      {
        to: "/investments",
        label: "Overview",
        icon: "chart-line",
        matchExact: ["/investments"],
        matchPrefixes: [],
      },
      {
        to: "/investments/stocks",
        label: "Stocks",
        icon: "trending-up",
        matchPrefixes: ["/investments/stocks"],
      },
      {
        to: "/investments/research",
        label: "Research",
        icon: "search",
        matchPrefixes: ["/investments/research"],
      },
    ],
  },
];

function isActive(pathname: string, item: SidebarItem): boolean {
  if (item.matchExact?.some((p) => pathname === p)) return true;
  return item.matchPrefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function AppShell() {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-muted/30">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function Sidebar() {
  const { pathname } = useLocation();

  return (
    <aside
      aria-label="Main navigation"
      className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-background text-sm text-foreground"
    >
      {/* Brand */}
      <Link
        to="/dashboard"
        className="flex items-center gap-2.5 border-b border-border px-4 py-4"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary text-xl">
          <i className="ti ti-building" aria-hidden />
        </span>
        <span className="text-base font-semibold tracking-tight">Helm</span>
      </Link>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {SECTIONS.map((section, idx) => (
          <div
            key={section.label}
            className={cn(
              "py-2",
              idx < SECTIONS.length - 1 && "border-b border-border/60",
            )}
          >
            <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.label}
            </div>
            {section.items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.to + item.label}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "my-0.5 flex items-center gap-3 rounded-md px-3 py-2 transition-colors",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  <i
                    className={cn(
                      "ti text-lg leading-none",
                      `ti-${item.icon}`,
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Pinned footer */}
      <SidebarFooter pathname={pathname} />
    </aside>
  );
}

function SidebarFooter({ pathname }: { pathname: string }) {
  const settingsActive =
    pathname === "/settings" || pathname.startsWith("/settings/");
  return (
    <div className="flex flex-col gap-2 border-t border-border px-2 py-3">
      <Link
        to="/settings"
        aria-current={settingsActive ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 transition-colors",
          settingsActive
            ? "bg-primary/10 text-primary"
            : "text-foreground hover:bg-muted",
        )}
      >
        <i
          className={cn(
            "ti ti-settings text-lg leading-none",
            settingsActive ? "text-primary" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span>Settings</span>
      </Link>
      <SignOutSidebarButton />
    </div>
  );
}

/**
 * Sign Out — bordered button that flips destructive red on hover.
 * Keeps the sign-out semantics from the old SignOutButton: clears the
 * React Query cache and routes back to the landing.
 */
function SignOutSidebarButton() {
  const { signOut } = useAuthenticator((c) => [c.signOut]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function handleSignOut() {
    signOut();
    queryClient.clear();
    navigate("/", { replace: true });
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      className={cn(
        "group mx-1 flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium",
        "transition-colors hover:border-destructive hover:text-destructive",
      )}
    >
      <i
        className="ti ti-logout text-lg leading-none text-muted-foreground transition-colors group-hover:text-destructive"
        aria-hidden
      />
      <span>Sign out</span>
    </button>
  );
}
