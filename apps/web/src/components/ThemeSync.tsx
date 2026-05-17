/**
 * ThemeSync — quietly hydrates the theme from the server's settings table
 * after the user is signed in.
 *
 * On app boot ``main.tsx`` applies the theme from ``localStorage`` so the
 * first paint is correct. This component runs once we have a session,
 * pulls the canonical ``theme`` setting from the API, and applies it (so
 * a theme change made on another device propagates).
 *
 * Renders nothing.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { applyTheme, isTheme, saveTheme } from "@/lib/theme";

type SettingsMap = Record<string, string>;

export function ThemeSync() {
  const { data } = useQuery<SettingsMap>({
    queryKey: ["settings"],
    queryFn: () => apiFetch<SettingsMap>("/business/settings/"),
    staleTime: 5 * 60_000,
    // We don't want a failed fetch (e.g. before sign-in) to surface as
    // a banner; ThemeSync is purely opportunistic.
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    const serverTheme = data["theme"];
    if (isTheme(serverTheme)) {
      applyTheme(serverTheme);
      saveTheme(serverTheme);
    }
  }, [data]);

  return null;
}
