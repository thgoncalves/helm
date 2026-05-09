/**
 * TypeScript types mirroring the FastAPI Pydantic models in
 * services/api/app/models/.
 *
 * Rules:
 * - UUIDs are typed as `string` (FastAPI serialises them to strings).
 * - Datetimes are typed as `string` (ISO 8601 UTC from FastAPI).
 * - Decimals are typed as `number | string | null` because Pydantic v2
 *   serialises Python `Decimal` to a JSON **string** by default (to
 *   preserve precision). Coerce to `number` at the rendering boundary.
 * - Field names stay snake_case to match the API response shape exactly.
 *   Map to camelCase in components if needed.
 *
 * Keep in sync with services/api/app/models/clients.py.
 * Future: replace with generated types from openapi.json via openapi-typescript.
 */

// ---------------------------------------------------------------------------
// Clients — mirrors ClientBase + ClientRead
// ---------------------------------------------------------------------------

/** Mirrors ClientRead in services/api/app/models/clients.py */
export interface ClientRead {
  /** Server-generated UUID primary key. */
  id: string;
  /** Display name of the client. */
  name: string;
  /** Contact email address. */
  email: string | null;
  /** Contact phone number. */
  phone: string | null;
  /** First line of billing address. */
  address_line1: string | null;
  /** Second line of billing address. */
  address_line2: string | null;
  /** City for billing address. */
  city: string | null;
  /** State/province for billing address. */
  state: string | null;
  /** Postal or ZIP code. */
  postal_code: string | null;
  /** Country for billing address. */
  country: string | null;
  /** Business tax/GST number. */
  tax_id: string | null;
  /** Free-form notes about the client. */
  notes: string | null;
  /** Whether the client is active. */
  is_active: boolean;
  /**
   * Default billing rate (currency determined by settings).
   * Pydantic v2 serialises Decimal to a JSON string ("185.00") to preserve
   * precision; older serialisers may emit a number. Accept both; coerce
   * with `Number()` at the rendering boundary.
   */
  hourly_rate: number | string | null;
  /** How often timesheets are submitted. */
  timesheet_frequency: string | null;
  /** ISO 8601 UTC timestamp when the record was created. */
  created_at: string;
  /** ISO 8601 UTC timestamp when the record was last updated. */
  updated_at: string;
}

/**
 * Mirrors ClientCreate in services/api/app/models/clients.py.
 *
 * Inherits all data fields from ClientRead except server-generated ones.
 * ``is_active`` is included here so PUT requests can toggle archive status.
 */
export interface ClientCreate
  extends Omit<ClientRead, "id" | "created_at" | "updated_at"> {}
