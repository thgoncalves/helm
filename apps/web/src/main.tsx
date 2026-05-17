/**
 * Application entry point.
 *
 * Order of operations:
 * 1. configureAmplify() — sets up Cognito credentials. Must run before any
 *    auth calls. Will throw if required VITE_* env vars are missing.
 * 2. QueryClientProvider — wraps the app with TanStack Query.
 * 3. App — renders the Router and all routes.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Authenticator } from "@aws-amplify/ui-react";

import { configureAmplify } from "@/lib/amplify";
import { applyTheme, loadTheme } from "@/lib/theme";
import { App } from "./App";
import "@aws-amplify/ui-react/styles.css";
import "./index.css";
import "./amplify-theme.css";

// Configure Amplify before rendering. This is synchronous and will throw
// with a clear message if any required env var is absent.
configureAmplify();

// Apply the saved theme synchronously so the first paint isn't a flash
// of the default palette. The server-side value is hydrated later via
// ThemeSync inside App.
applyTheme(loadTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't refetch on window focus in development — avoids noise.
      refetchOnWindowFocus: import.meta.env.PROD,
      retry: 1,
      // Default staleTime is 0, which means every component mount refetches.
      // Since most of the data here changes a few times a day at most (and
      // Aurora cold-resume penalises every fresh request), 30 seconds is a
      // reasonable starting point. Mutations explicitly invalidate the
      // affected queries, so this doesn't make any list "stale" after an
      // edit — only avoids redundant fetches when you bounce between
      // sibling pages.
      staleTime: 30_000,
      // Keep entries in the cache for 10 minutes so a back-and-forth
      // navigation pulls from cache instead of the network.
      gcTime: 10 * 60_000,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Authenticator.Provider>
        <App />
      </Authenticator.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
