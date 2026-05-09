# Helm — Vision & Requirements

> A unified financial hub for personal finances and small-business operations,
> built TypeScript-first and deployed on AWS.

## What is Helm?

Helm is a single-user (you) financial hub split into two top-level domains:

- **Personal** — budgeting, transactions imported from bank CSVs, investment
  tracking, net-worth dashboard.
- **Business** (primary focus) — timesheets, invoices, payments, taxes (GST),
  owner transfers, receipts, clients, dashboards.

The two domains are logically separated (separate ledgers, separate
dashboards, separate accounts) but share auth, settings, and infrastructure.

## Context: this is a rewrite

A working PyQt5 desktop app already exists locally and contains real
financial records going back to 2022 (Australian operations, then Canadian).
Its CSV "database" sits in `old_database/` (ignored by git, kept locally for
reference). Helm replaces that app with a hosted, multi-device, web-first
version.

The Business side of Helm V1 must:

- Cover every feature of the existing PyQt5 app at parity or better.
- Migrate the historical CSV data into the new database, preserving UUIDs
  and invoice numbers (e.g. `202203-001`).

The Personal side is greenfield — the legacy app does not include personal
budgeting, transactions, or investments.

## Personal features

| Feature | Description |
|---|---|
| **Budget control** | YNAB-style envelope budgeting. Categories, monthly assignments, rollover. |
| **CSV import** | Drop a CSV exported from your bank; map columns; categorise; deduplicate against existing transactions. |
| **Investments** | Portfolio holdings, transaction log, time-series valuation, asset allocation. |
| **Dashboard** | Net worth, cashflow, spending trends, savings rate. |

## Business features

| Feature | Description |
|---|---|
| **Dashboard** | KPIs (revenue, hours billed, GST owed, AR aging) and charts. |
| **Timesheet** | Hours per day per client. No description required per entry. Generates a client-ready PDF on submit. |
| **Invoices** | Auto-created when a timesheet is submitted: total hours × rate, plus configurable GST (default 5%). |
| **Payments** | When an invoice is paid, recorded here for reconciliation. |
| **Taxes** | Track GST remittance (every 2 months). For each remittance: how much, to whom, and which invoices it covers. |
| **Transfers** | Business → Personal owner draws. Calculates total taxes owed both sides and total paid YTD. |
| **Clients** | Mini-CRM: contact info, billing address, default rate, GST rate, notes. |
| **Receipts** | Snap a receipt with the iPhone camera. Image + extracted fields (vendor, date, amount, GST). |
| **Settings** | Tax rates, currency, business profile, branding for invoices/timesheets, default client config. |

## Non-functional requirements

- **TypeScript-first.** Every layer where it's a viable choice.
- **AWS-native.** No external SaaS for primary infrastructure.
- **Deployed via Amplify Hosting** with two long-lived branches:
  `main` → prod, `dev` → dev environment.
- **Cognito** for authn/authz.
- **S3** for image and document storage.
- **iPhone-first for receipts.** Web-first for everything else.
- **Custom domain** wired in once the app is ready to live somewhere.

## Out of scope (V1)

- Multi-user / team collaboration.
- Bank-feed integration (Plaid, etc.) — CSV import only for V1.
- Receipt OCR automation — V1 stores images + manual fields. OCR comes later.
- Real-time / collaborative dashboards.
- Mobile-native app shell — V1 is a PWA. Capacitor wrapper if/when needed.
