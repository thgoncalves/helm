/**
 * App-wide theme management.
 *
 * Theme is persisted in two places so the app feels instant:
 *
 *   1. ``localStorage`` (key ``helm:theme``) — read synchronously on app
 *      boot so the first paint already shows the right colours.
 *   2. The server-side ``settings`` table under the key ``theme`` — kept
 *      in sync via ``PUT /business/settings/`` so the choice follows the
 *      user across devices.
 *
 * ``applyTheme`` writes a single class onto ``<html>``. The CSS in
 * ``index.css`` defines ``.theme-catppuccin`` and ``.theme-tokyo-night``
 * which override the shadcn CSS variables.
 */

export const THEMES = ["default", "catppuccin", "tokyo-night"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  default: "Default",
  catppuccin: "Catppuccin (Mocha)",
  "tokyo-night": "Tokyo Night",
};

const STORAGE_KEY = "helm:theme";

const ALL_CLASSES = THEMES.filter((t) => t !== "default").map(
  (t) => `theme-${t}`,
);

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Read the saved theme from localStorage, or fall back to "default". */
export function loadTheme(): Theme {
  if (typeof window === "undefined") return "default";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : "default";
}

/** Persist the theme to localStorage. */
export function saveTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Apply a theme by toggling classes on ``<html>``. Removes any other
 * theme classes first so switching is clean.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const cls of ALL_CLASSES) root.classList.remove(cls);
  if (theme !== "default") {
    root.classList.add(`theme-${theme}`);
  }
}
