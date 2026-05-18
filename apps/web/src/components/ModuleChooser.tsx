/**
 * ModuleChooser — three-tile chooser rendered after sign-in to let the
 * user pick which Helm module to land on.
 *
 * Visual language:
 *  - Mirrors the AppHeader's `ModuleSwitcher` pill so the two reinforce
 *    each other, but at "feature card" scale: three large tappable cards
 *    with title, one-line description, and a soft accent border on hover.
 *  - All colors come from semantic shadcn tokens so every theme works.
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ModuleId } from "@/lib/module";

interface ModuleChooserProps {
  /** Optional initial selection used for the keyboard ring on mount. */
  value?: ModuleId;
  onChoose: (mod: ModuleId) => void;
}

interface Tile {
  id: ModuleId;
  title: string;
  blurb: string;
  icon: ReactNode;
}

const TILES: readonly Tile[] = [
  {
    id: "business",
    title: "Business",
    blurb:
      "Clients, timesheets, invoices, payments, expenses, GST and transfers.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-8 w-8"
        aria-hidden
      >
        <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
        <path d="M11 21V11h8a2 2 0 0 1 2 2v8" />
        <path d="M7 9h.01M7 13h.01M7 17h.01" />
        <path d="M15 15h.01M15 18h.01" />
      </svg>
    ),
  },
  {
    id: "money",
    title: "Money",
    blurb:
      "YNAB-driven macro dashboard, monthly pacing, and bill-over-budget alerts.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-8 w-8"
        aria-hidden
      >
        <path d="M3 17v-7l4 3 4-6 4 4 6-7" />
        <path d="M21 4h-5" />
        <path d="M21 4v5" />
        <path d="M3 21h18" />
      </svg>
    ),
  },
  {
    id: "investments",
    title: "Investing",
    blurb:
      "Portfolio tracking with target-allocation drift and research suggestions (soon).",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-8 w-8"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 9 9h-9z" />
        <path d="M12 12 7 8" />
      </svg>
    ),
  },
];

export function ModuleChooser({ value, onChoose }: ModuleChooserProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Choose a module to open"
      className="grid w-full gap-3 sm:grid-cols-3"
    >
      {TILES.map((tile) => (
        <Tile
          key={tile.id}
          tile={tile}
          active={tile.id === value}
          onClick={() => onChoose(tile.id)}
        />
      ))}
    </div>
  );
}

function Tile({
  tile,
  active,
  onClick,
}: {
  tile: Tile;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "group flex h-full flex-col gap-2 rounded-xl border p-5 text-left",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-muted/30 shadow-sm"
          : "border-border bg-card hover:border-input hover:bg-muted/30",
      )}
    >
      <span
        className={cn(
          "inline-flex h-12 w-12 items-center justify-center rounded-lg",
          "bg-muted text-primary",
          "transition-colors group-hover:bg-primary/10",
        )}
        aria-hidden
      >
        {tile.icon}
      </span>
      <span className="text-lg font-semibold text-foreground">
        {tile.title}
      </span>
      <span className="text-sm text-muted-foreground">{tile.blurb}</span>
    </button>
  );
}
