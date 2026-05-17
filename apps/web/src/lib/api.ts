/**
 * API fetch wrapper.
 *
 * Attaches the Cognito JWT from the active session to every request and
 * prepends VITE_API_URL. Throws ApiError for non-2xx responses.
 *
 * @example
 * ```ts
 * const clients = await apiFetch<ClientRead[]>('/business/clients');
 * ```
 */
import { fetchAuthSession } from "aws-amplify/auth";

/** Thrown for any non-2xx HTTP response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `API error ${status}`);
    this.name = "ApiError";
  }
}

function getApiBase(): string {
  const base = import.meta.env["VITE_API_URL"] as string | undefined;
  if (!base) {
    throw new Error(
      "Missing VITE_API_URL. Add it to .env.local and restart the dev server.",
    );
  }
  // Strip trailing slash so callers can safely pass '/path' with a leading slash.
  return base.replace(/\/$/, "");
}

/**
 * Fetch a JSON endpoint on the Helm API, automatically attaching the
 * Cognito Bearer token.
 *
 * @param path - Path starting with `/`, e.g. `/business/clients`.
 * @param init - Optional RequestInit overrides (method, body, headers, …).
 * @returns Parsed JSON response body typed as T.
 * @throws {ApiError} When the server responds with a non-2xx status.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const session = await fetchAuthSession();
  const jwt = session.tokens?.idToken?.toString();

  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (jwt) {
    headers.set("Authorization", `Bearer ${jwt}`);
  }

  const url = `${getApiBase()}${path}`;
  const response = await fetch(url, { ...init, headers });

  // Try to parse JSON for both success and error responses.
  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    throw new ApiError(response.status, body);
  }

  return body as T;
}

/**
 * Fetch a binary endpoint (e.g. PDF) on the Helm API and return it as a
 * Blob. Attaches the Cognito Bearer token like :func:`apiFetch`.
 *
 * @throws {ApiError} When the server responds with a non-2xx status.
 */
export async function apiFetchBlob(
  path: string,
  init: RequestInit = {},
): Promise<Blob> {
  const session = await fetchAuthSession();
  const jwt = session.tokens?.idToken?.toString();

  const headers = new Headers(init.headers);
  if (jwt) {
    headers.set("Authorization", `Bearer ${jwt}`);
  }

  const url = `${getApiBase()}${path}`;
  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    throw new ApiError(response.status, body);
  }

  return response.blob();
}
