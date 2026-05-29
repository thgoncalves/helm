# Dashboard: register money on the paid date, not the issue date

## Context

On **Business > Dashboard**, the charts attribute income to the invoice's
`issue_date` (when the invoice was emitted) rather than when it was actually
paid. The user wants the dashboard to reflect *cash actually received* — money
should register on the date a payment lands, not when the invoice was issued.

The data model already supports this cleanly:
- `invoices.issue_date` — when emitted (currently used by the charts).
- `payments_received` — has `invoice_id`, `payment_date`, `amount`. This is the
  source of truth for cash received. Multiple payments can link to one invoice,
  so partial payments naturally split across months.

Decision (confirmed with user): **every money chart becomes purely paid-based**,
measured by **actual payments received** — sum `payments_received.amount` on its
`payment_date`. This removes the "Invoiced vs Received" comparison from Cash Flow
and Quarterly. Per-client breakdowns map `payment.invoice_id → invoice.client_id`.

**Out of scope (intentionally unchanged):**
- **KPI cards** ("FY Invoiced", "FY Received", "Outstanding", "Invoices", GST,
  transfers). These are clearly labelled and already separate Invoiced from
  Received; "FY Invoiced" is a legitimate billing metric, not mis-dated cash.
- **Aging** ("Outstanding by Age"). Correctly uses `issue_date` to measure how
  long *unpaid* invoices have been outstanding — that is its purpose.

**Heads-up / known consequence:** once Cash Flow is received-only, its monthly
totals equal Monthly Revenue's totals (Monthly Revenue just adds a per-client
breakdown). They stay as two different visualizations (area vs stacked bar); I'm
keeping both per the "every money chart" choice. Easy to drop/repurpose Cash Flow
later if it feels redundant.

## Files to change

### Backend — `services/api/app/routers/dashboard.py`
The aggregation is plain-Python over raw SELECTs (no SQL GROUP BY), so this is
straightforward. Add a `client_id_by_invoice: dict[UUID, UUID]` lookup built from
the already-fetched `invoices`, then re-point each chart at `payments`:

- **Monthly Revenue** (`monthly_by_client` / `monthly_totals`, ~L385-419):
  iterate `payments` whose `payment_date` is in the FY; bucket by
  `_fy_month_index(payment_date)`; client = `client_id_by_invoice[p["invoice_id"]]`;
  amount = `p["amount"]`.
- **Top Clients** (`client_totals`, ~L421-440): sum `p["amount"]` per client (via
  the invoice→client map) for payments in the FY; top 5.
- **Cash Flow** (~L442-462): drop the issue-date `invoiced` series. Keep
  `received` per month (already payment-date based). Change `CashFlowPoint` to
  `{month, received}`.
- **Quarterly** (~L464-484): drop `invoiced`; keep `received` per quarter. Change
  `QuarterlyPoint` to `{quarter, received}`.
- **By Fiscal Year** (~L486-507): drop `invoiced`; keep `received` (frontend
  already only plots received). Derive FY rows from payment dates only. Change
  `FYIncomePoint` to `{fy_label, received}`.
- Update the module docstring (L1-26) to state charts are paid-date / cash-basis.

Leave untouched: all KPI helpers (`sum_invoices_in`, `sum_payments_in`, etc.),
`outstanding`, GST, transfers, and the **aging** block (~L509-537).

### API types — `apps/web/src/types/api.ts` (L410-426)
- `CashFlowPoint` → `{ month; received }`
- `QuarterlyPoint` → `{ quarter; received }`
- `FYIncomePoint` → `{ fy_label; received }`

### Frontend — `apps/web/src/routes/Dashboard.tsx`
- `cashFlowRows` (L215-222): drop `invoiced`. In the Cash Flow card (L446-531)
  remove the `invoiced` `<Area>`, the `grad-invoiced` gradient, and retitle
  "Cash Flow: Invoiced vs Received" → "Cash Flow (Received)". Keep the received area.
- `quarterlyRows` (L224-231): drop `invoiced`. Remove the `invoiced` `<Bar>`
  (L561-565). Keep the received bar.
- `fyRows` (L233-240): drop `invoiced` (the chart already only renders received).
- Top Clients empty state (L391): "No clients invoiced this FY yet." → "No
  payments received this FY yet."
- Monthly Revenue / Top Clients chart logic (`monthlyRows`, `stackClients`,
  `topClientRows`) needs **no structural change** — the response shapes
  (`by_client`, `top_clients`) are unchanged; only their source is now payments.
  Update the file's top doc comment to note cash-basis.

### Tests — `services/api/tests/test_dashboard_router.py`
The helpers `_invoice` and `_payment` already exist. Rewrite the chart tests in
`TestCharts` to seed payments and assert on `payment_date`:
- `test_monthly_revenue_breaks_down_by_client`: create invoices for two clients,
  add payments in a given month, assert that month's `total` + `by_client` reflect
  the **payments** (and that an unpaid invoice contributes nothing).
- `test_top_clients_ranks_descending`: rank by amount **received**.
- `test_cash_flow_*`: rename to reflect received-only; assert `received` per
  month, assert the `invoiced` key is gone.
- `test_quarterly_*`: assert `received` for the quarter of the payment.
- `test_by_fiscal_year_*`: assert `received` grouped by payment `payment_date` FY.
- Keep `test_aging_buckets_use_days_since_issue` and all of `TestKPIs` as-is
  (`fy_invoiced` stays issue-based).
- `TestEmpty` still holds (zeros, empty lists, 12 months, 4 quarters).

## Workflow (per project conventions)
- Copy this plan to `docs/specs/` once approved.
- Branch off `dev` (e.g. `feat/dashboard-cash-basis`); implement there.

## Verification
1. **Backend tests:** `cd services/api && <pytest runner> tests/test_dashboard_router.py`
   — confirm the rewritten chart tests pass and KPI/aging tests still pass.
2. **Frontend typecheck/build:** run the web app's typecheck (e.g. `pnpm -C apps/web typecheck`/`build`) to confirm the type changes compile.
3. **UI smoke (golden path):** run the web app, sign in, open the Dashboard.
   Seed an invoice issued in month A with a payment in a later month B; confirm
   Monthly Revenue / Cash Flow / Quarterly / FY all show the amount in B (paid),
   not A (issued), while the "FY Invoiced" KPI and Aging still reference issue date.
   Verify with the UX agent + Playwright per the usual flow.
