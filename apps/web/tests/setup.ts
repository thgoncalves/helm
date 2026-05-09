/**
 * Vitest global test setup.
 *
 * - Extends expect with @testing-library/jest-dom matchers.
 * - Mocks aws-amplify/auth so tests never hit real AWS endpoints.
 * - Mocks the global fetch to prevent real network calls.
 */
import "@testing-library/jest-dom";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock aws-amplify/auth
// ---------------------------------------------------------------------------
// Individual test files can override these with vi.mocked(...).mockResolvedValue(...)
vi.mock("aws-amplify/auth", () => ({
  getCurrentUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock aws-amplify (the Amplify.configure call in src/lib/amplify.ts)
// ---------------------------------------------------------------------------
vi.mock("aws-amplify", () => ({
  Amplify: {
    configure: vi.fn(),
  },
}));

// VITE_* env vars for tests are defined in vite.config.ts under test.env.
