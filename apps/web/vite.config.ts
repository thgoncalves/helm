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
