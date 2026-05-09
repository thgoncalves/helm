/**
 * Tests for src/lib/api.ts — apiFetch helper.
 *
 * Mocks:
 * - fetchAuthSession (aws-amplify/auth) — provides a fake JWT.
 * - global fetch — prevents real network calls and controls responses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAuthSession } from "aws-amplify/auth";
import { apiFetch, ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSession(jwt: string | undefined) {
  vi.mocked(fetchAuthSession).mockResolvedValue({
    tokens: jwt
      ? {
          idToken: {
            toString: () => jwt,
            payload: {},
            // minimal mock — real token has more fields
          } as unknown as Awaited<
            ReturnType<typeof fetchAuthSession>
          >["tokens"]["idToken"],
        }
      : undefined,
  } as Awaited<ReturnType<typeof fetchAuthSession>>);
}

function mockFetch(status: number, body: unknown, contentType = "application/json") {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches Authorization header with Bearer token", async () => {
    const jwt = "test.jwt.token";
    mockSession(jwt);
    mockFetch(200, { ok: true });

    await apiFetch("/business/clients/");

    const fetchMock = vi.mocked(fetch);
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    expect(init.headers.get("Authorization")).toBe(`Bearer ${jwt}`);
  });

  it("prepends VITE_API_URL to the path", async () => {
    mockSession("tok");
    mockFetch(200, []);

    await apiFetch("/business/clients/");

    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/business/clients/");
  });

  it("returns parsed JSON for a 2xx response", async () => {
    mockSession("tok");
    const payload = [{ id: "1", name: "Acme" }];
    mockFetch(200, payload);

    const result = await apiFetch("/business/clients/");
    expect(result).toEqual(payload);
  });

  it("throws ApiError with correct status for a 4xx response", async () => {
    mockSession("tok");

    // Mock fetch twice — once for each call in this test.
    const make404 = () =>
      new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(make404()).mockResolvedValueOnce(make404()),
    );

    await expect(apiFetch("/business/clients/bad")).rejects.toThrow(ApiError);

    try {
      await apiFetch("/business/clients/bad");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });

  it("throws ApiError with correct status for a 5xx response", async () => {
    mockSession("tok");
    mockFetch(500, { detail: "Internal Server Error" });

    await expect(apiFetch("/business/clients/")).rejects.toThrow(ApiError);
  });

  it("works without a JWT (no Authorization header set if session has no tokens)", async () => {
    mockSession(undefined);
    mockFetch(200, []);

    await apiFetch("/business/clients/");

    const fetchMock = vi.mocked(fetch);
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }];
    // No JWT → no Authorization header
    expect(init.headers.get("Authorization")).toBeNull();
  });
});
