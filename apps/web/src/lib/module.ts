/**
 * Top-level module identity for Helm.
 *
 * Helm is split into three peer modules; the user can flip between them
 * via the AppShell's switcher pill. This module owns:
 *
 *  - the `ModuleId` type and the `MODULES` ordered tuple (so AppShell,
 *    ModuleChooser, and tests share one source of truth)
 *  - localStorage persistence for "last module used", which the
 *    post-sign-in chooser uses to fast-forward returning users.
 */

export const MODULES = ["business", "money", "investments"] as const;

export type ModuleId = (typeof MODULES)[number];

const STORAGE_KEY = "helm:lastModule";

export function isModuleId(value: unknown): value is ModuleId {
  return (
    typeof value === "string" &&
    (MODULES as readonly string[]).includes(value)
  );
}

/**
 * Read the user's last-used module from localStorage, or null when no
 * choice has been made yet (or when storage is unavailable, e.g. SSR).
 */
export function loadLastModule(): ModuleId | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isModuleId(raw) ? raw : null;
  } catch {
    // localStorage can throw in Safari private mode; treat as "no memory".
    return null;
  }
}

/**
 * Persist the user's chosen module so the next sign-in lands on the same
 * module without showing the chooser again.
 */
export function rememberModule(mod: ModuleId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mod);
  } catch {
    // Silently no-op — sticky landing is a nice-to-have, not load-bearing.
  }
}
