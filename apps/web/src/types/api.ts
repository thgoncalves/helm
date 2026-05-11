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
  /**
   * Total monetary value of the active contract (used to compute
   * remaining $/hours on the timesheet page). Decimal serialised as string.
   */
  contract_value: number | string | null;
  /** ISO currency code for ``contract_value`` (default ``"CAD"``). */
  contract_currency: string | null;
  /** Default task description printed on every populated PDF row. */
  default_task_description: string | null;
  /**
   * Whether invoices auto-created from this client's timesheet should apply
   * GST by default. Mirrors clients.default_taxable.
   */
  default_taxable: boolean;
  /** Default GST/tax rate as a decimal (e.g. "0.0500" for 5%). */
  default_tax_rate: number | string | null;
  /** Net-N payment terms in days (e.g. 30 for "Net 30", 15 for Wenco). */
  default_payment_terms_days: number;
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

// ---------------------------------------------------------------------------
// Time entries — mirrors TimeEntryRead
// ---------------------------------------------------------------------------

/** Mirrors TimeEntryRead in services/api/app/models/time_entries.py */
export interface TimeEntryRead {
  id: string;
  client_id: string;
  /** Calendar date (YYYY-MM-DD). */
  work_date: string;
  /** Hours worked, e.g. ``"7.50"`` (Decimal serialised as string). */
  hours: number | string;
  /** Invoice this entry is included on; ``null`` if uninvoiced. */
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Timesheet summary — mirrors TimesheetSummary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Invoices — mirrors InvoiceRead + InvoiceLineItemRead
// ---------------------------------------------------------------------------

export interface InvoiceRead {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  client_id: string;
  status: string;
  currency: string;
  subtotal: number | string;
  tax_amount: number | string;
  total: number | string;
  notes: string | null;
  payment_terms: string | null;
  attachments_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceLineItemRead {
  id: string;
  invoice_id: string;
  line_order: number;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  tax_category: string | null;
  is_taxable: boolean;
  tax_rate: number | string | null;
  line_subtotal: number | string;
  line_tax: number | string;
  line_total: number | string;
}

export interface InvoiceLineItemInput {
  line_order: number;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  is_taxable: boolean;
  tax_rate: number | string | null;
  tax_category: string | null;
}

export interface InvoiceWithLines {
  invoice: InvoiceRead;
  line_items: InvoiceLineItemRead[];
}

export interface InvoiceStatusTotals {
  draft: number | string;
  sent: number | string;
  overdue: number | string;
  paid: number | string;
  total: number | string;
}

export interface InvoiceListResponse {
  invoices: InvoiceRead[];
  totals_by_status: InvoiceStatusTotals;
}

export interface SubmitTimesheetResponse {
  invoice: InvoiceRead;
}

/** Mirrors TimesheetSummary in services/api/app/routers/timesheets.py */
export interface TimesheetSummary {
  client_id: string;
  period_start: string;
  period_end: string;
  hourly_rate: number | string | null;
  contract_value: number | string | null;
  contract_currency: string | null;
  period_hours: number | string;
  period_amount: number | string;
  contract_hours_logged: number | string;
  contract_amount_logged: number | string;
  contract_remaining_hours: number | string | null;
  contract_remaining_amount: number | string | null;
}
