import { type SVGProps } from "react";

/**
 * Ship's helm — the brand mark.
 *
 * Color comes from `currentColor`; size from className/style. 8-spoke
 * traditional wheel with handle knobs at the spoke ends.
 */
export function HelmIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <line x1="100" y1="10" x2="100" y2="190" />
        <line x1="10" y1="100" x2="190" y2="100" />
        <line x1="36" y1="36" x2="164" y2="164" />
        <line x1="36" y1="164" x2="164" y2="36" />
      </g>
      <circle
        cx="100"
        cy="100"
        r="65"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
      />
      <circle cx="100" cy="100" r="14" fill="currentColor" />
      <g fill="currentColor">
        <circle cx="100" cy="10" r="8" />
        <circle cx="100" cy="190" r="8" />
        <circle cx="10" cy="100" r="8" />
        <circle cx="190" cy="100" r="8" />
        <circle cx="36" cy="36" r="8" />
        <circle cx="164" cy="164" r="8" />
        <circle cx="36" cy="164" r="8" />
        <circle cx="164" cy="36" r="8" />
      </g>
    </svg>
  );
}
