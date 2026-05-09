import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Source maps double rollup memory and aren't useful in production.
    sourcemap: false,
    // Split aws-amplify (the largest dep) into its own chunk so rollup
    // processes it separately. Reduces peak memory during tree-shaking
    // and silences the 500 kB chunk-size warning.
    rollupOptions: {
      output: {
        manualChunks: {
          amplify: ["aws-amplify", "aws-amplify/auth"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    env: {
      VITE_API_URL: "https://api.example.com",
      VITE_AWS_REGION: "ca-central-1",
      VITE_COGNITO_USER_POOL_ID: "ca-central-1_TEST",
      VITE_COGNITO_USER_POOL_CLIENT_ID: "test-client-id",
    },
  },
});
