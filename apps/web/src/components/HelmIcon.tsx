import { type SVGProps } from "react";

/**
 * Ship's helm — the Helm brand mark.
 *
 * SVG, single-color via `currentColor`, designed to read cleanly at any
 * size from 16px to 64px. Pass ``className`` to set size and colour
 * (e.g. ``text-foreground``, ``text-primary``) — the icon inherits the
 * current text colour, so it adapts to every theme automatically.
 *
 * Construction (24×24 viewBox):
 * - Outer rim — stroke circle.
 * - 8-arm spoke pattern — 4 lines through the centre, each extending
 *   ~2 units past the rim. The protrusions double as handle pegs, which
 *   keeps the silhouette readable when separate handle dots would just
 *   look like noise at small sizes.
 * - Solid hub at the centre.
 */
export function HelmIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* Outer rim */}
      <circle cx="12" cy="12" r="8" />
      {/* Spokes (4 lines through centre = 8 visible arms; protrusions = handles) */}
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      <line x1="19.07" y1="4.93" x2="4.93" y2="19.07" />
      {/* Hub */}
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
