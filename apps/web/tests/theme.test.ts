/**
 * Tests for src/lib/theme.ts — the pure theme helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyTheme,
  isTheme,
  loadTheme,
  saveTheme,
  THEMES,
} from "@/lib/theme";

describe("isTheme", () => {
  it("accepts the known theme keys", () => {
    for (const t of THEMES) {
      expect(isTheme(t)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isTheme("solarized")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(isTheme(42)).toBe(false);
  });
});

describe("save / load round-trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("loadTheme returns 'default' when nothing is stored", () => {
    expect(loadTheme()).toBe("default");
  });

  it("saveTheme then loadTheme survives the cycle", () => {
    saveTheme("catppuccin");
    expect(loadTheme()).toBe("catppuccin");
    saveTheme("tokyo-night");
    expect(loadTheme()).toBe("tokyo-night");
  });

  it("loadTheme ignores a stored value that isn't a known theme", () => {
    window.localStorage.setItem("helm:theme", "monokai");
    expect(loadTheme()).toBe("default");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.className = "";
  });

  it("adds the appropriate class for non-default themes", () => {
    applyTheme("catppuccin");
    expect(document.documentElement.classList.contains("theme-catppuccin")).toBe(
      true,
    );
    applyTheme("tokyo-night");
    expect(document.documentElement.classList.contains("theme-tokyo-night")).toBe(
      true,
    );
    // Prior theme class is removed.
    expect(document.documentElement.classList.contains("theme-catppuccin")).toBe(
      false,
    );
  });

  it("removes all theme classes for the default theme", () => {
    document.documentElement.classList.add("theme-catppuccin");
    applyTheme("default");
    expect(document.documentElement.className).not.toContain("theme-");
  });
});
