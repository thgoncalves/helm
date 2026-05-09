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
import { App } from "./App";
import "@aws-amplify/ui-react/styles.css";
import "./index.css";
import "./amplify-theme.css";

// Configure Amplify before rendering. This is synchronous and will throw
// with a clear message if any required env var is absent.
configureAmplify();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't refetch on window focus in development — avoids noise.
      refetchOnWindowFocus: import.meta.env.PROD,
      retry: 1,
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
