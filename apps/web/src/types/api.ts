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
  /**
   * Start of the contract window (YYYY-MM-DD). Used by the pacing widget
   * on the Timesheets page to compute required hours/day.
   */
  contract_start_date: string | null;
  /**
   * End of the contract window (YYYY-MM-DD). When set, the pacing widget
   * shows required pace = remaining_hours / business_days_remaining.
   */
  contract_end_date: string | null;
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

// ---------------------------------------------------------------------------
// Payments — mirrors PaymentReceived models + landing-row + invoice-option
// ---------------------------------------------------------------------------

export interface PaymentRead {
  id: string;
  invoice_id: string;
  payment_date: string;
  amount: number | string;
  payment_method: string | null;
  reference: string | null;
  notes: string | null;
  deduction_amount: number | string;
  deduction_description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentCreate {
  invoice_id: string;
  payment_date: string;
  amount: number | string;
  payment_method: string | null;
  reference: string | null;
  notes: string | null;
  deduction_amount: number | string;
  deduction_description: string | null;
}

/** Enriched row for the Payments landing table. */
export interface PaymentListRow {
  id: string;
  payment_date: string;
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  amount: number | string;
  deduction_amount: number | string;
  net: number | string;
  payment_method: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Invoice dropdown option with balance_due. */
export interface InvoiceOption {
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  total: number | string;
  balance_due: number | string;
  status: string;
}

// ---------------------------------------------------------------------------
// Tax payments (GST)
// ---------------------------------------------------------------------------

export interface TaxPaymentRead {
  id: string;
  tax_id: string | null;
  payment_date: string;
  amount: number | string;
  payment_method: string | null;
  payment_reference: string | null;
  fiscal_year: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxSummary {
  gst_unpaid: number | string;
  unpaid_income: number | string;
  total_gst_paid: number | string;
}

export interface TaxPaymentListRow {
  id: string;
  payment_date: string;
  amount: number | string;
  payment_method: string | null;
  payment_reference: string | null;
  notes: string | null;
  invoice_count: number;
  income: number | string;
}

export interface LinkableInvoice {
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  issue_date: string;
  total: number | string;
  tax_amount: number | string;
  is_linked: boolean;
}

export interface UnpaidInvoice {
  invoice_id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  issue_date: string;
  total: number | string;
  tax_amount: number | string;
}

export interface TaxPaymentWithLinks {
  payment: TaxPaymentRead;
  linked_invoices: LinkableInvoice[];
}

export interface TaxPaymentCreate {
  payment_date: string;
  amount: number | string;
  payment_method: string | null;
  payment_reference: string | null;
  notes: string | null;
  invoice_ids: string[];
}

// ---------------------------------------------------------------------------
// Transfers (Company → Personal)
// ---------------------------------------------------------------------------

export interface TransferRead {
  id: string;
  transfer_date: string;
  amount: number | string;
  method: string | null;
  purpose: string | null;
  category: string | null;
  estimated_tax_company: number | string | null;
  estimated_tax_personal: number | string | null;
  actual_tax_paid_company: number | string | null;
  actual_tax_paid_personal: number | string | null;
  tax_ledger_link_company: string | null;
  tax_ledger_link_personal: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferCreate {
  transfer_date: string;
  amount: number | string;
  method: string | null;
  purpose: string | null;
  category: string | null;
  estimated_tax_company: number | string | null;
  estimated_tax_personal: number | string | null;
  actual_tax_paid_company: number | string | null;
  actual_tax_paid_personal: number | string | null;
  tax_ledger_link_company: string | null;
  tax_ledger_link_personal: string | null;
  notes: string | null;
}

export interface TransferSummary {
  total_transferred: number | string;
  transaction_count: number;
  est_company_tax: number | string;
  est_personal_tax: number | string;
  tax_exposure: number | string;
}

export interface TransferTaxRates {
  company_rate: number | string;
  personal_rate: number | string;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface KPI {
  value: number | string;
  prev_value: number | string | null;
  delta_pct: number | string | null;
  detail: string | null;
}

export interface DashboardKPIs {
  fy_invoiced: KPI;
  fy_received: KPI;
  outstanding: KPI;
  invoice_count: KPI;
  gst_collected: KPI;
  gst_owed: KPI;
  transfers_fy: KPI;
  tax_exposure: KPI;
}

export interface ClientSliceAmount {
  client_id: string;
  client_name: string;
  amount: number | string;
}

export interface MonthlyRevenuePoint {
  month: string;
  total: number | string;
  by_client: ClientSliceAmount[];
}

export interface TopClient {
  client_id: string;
  client_name: string;
  total: number | string;
}

export interface CashFlowPoint {
  month: string;
  invoiced: number | string;
  received: number | string;
}

export interface QuarterlyPoint {
  quarter: string;
  invoiced: number | string;
  received: number | string;
}

export interface FYIncomePoint {
  fy_label: string;
  invoiced: number | string;
  received: number | string;
}

export interface AgingBucket {
  label: string;
  count: number;
  amount: number | string;
}

export interface DashboardResponse {
  fy_start: string;
  fy_end: string;
  today: string;
  kpis: DashboardKPIs;
  monthly_revenue: MonthlyRevenuePoint[];
  top_clients: TopClient[];
  cash_flow: CashFlowPoint[];
  quarterly: QuarterlyPoint[];
  by_fiscal_year: FYIncomePoint[];
  aging: AgingBucket[];
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export type ExpenseStatus = "pending" | "processing" | "ready" | "failed";

export interface ExpenseRead {
  id: string;
  status: ExpenseStatus;
  s3_key: string;
  content_type: string | null;
  size_bytes: number | null;
  expense_date: string | null;
  supplier: string | null;
  category: string | null;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total: number | string | null;
  currency: string | null;
  notes: string | null;
  ocr_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseCreateRequest {
  file_extension?: string;
  content_type?: string;
  size_bytes?: number;
}

export interface ExpenseCreateResponse {
  expense: ExpenseRead;
  upload_url: string;
}

export interface ExpenseUpdate {
  expense_date: string | null;
  supplier: string | null;
  category: string | null;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total: number | string | null;
  currency: string | null;
  notes: string | null;
}

export interface ExpenseImageUrlResponse {
  url: string;
}

// ---------------------------------------------------------------------------
// Personal — accounts, imports, transactions
// ---------------------------------------------------------------------------

export type Institution = "RBC" | "TD" | "Scotia" | "Other";
export type PersonalAccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "cash";

export interface PersonalAccountRead {
  id: string;
  name: string;
  institution: Institution;
  account_type: PersonalAccountType;
  currency: string;
  opening_balance: number | string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalAccountCreate {
  name: string;
  institution: Institution;
  account_type: PersonalAccountType;
  currency: string;
  opening_balance: number | string | null;
  is_active: boolean;
  notes: string | null;
}

export type PersonalImportStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed";

export interface PersonalImportRead {
  id: string;
  account_id: string;
  institution: Institution;
  status: PersonalImportStatus;
  s3_key: string;
  filename: string | null;
  size_bytes: number | null;
  row_count: number | null;
  imported_count: number | null;
  skipped_count: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalImportCreateRequest {
  account_id: string;
  institution: Institution;
  filename?: string;
  size_bytes?: number;
}

export interface PersonalImportCreateResponse {
  // Backend serialises the key as `import_` (Python keyword).
  import_: PersonalImportRead;
  upload_url: string;
}

export interface PersonalTransactionRead {
  id: string;
  account_id: string;
  import_id: string | null;
  posted_date: string;
  description: string;
  amount: number | string;
  balance: number | string | null;
  category: string | null;
  external_id: string | null;
  created_at: string;
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
