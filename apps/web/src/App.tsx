/**
 * App — root Router with all application routes.
 *
 * Helm is organised into three peer modules:
 *
 *   - Business       (the legacy contractor app — Dashboard, Clients,
 *                    Invoices, Payments, Expenses, Taxes, Transfers, Settings)
 *   - Money          (YNAB-driven personal cash-flow dashboard +
 *                    bill-over-budget alerts)
 *   - Investments    (portfolio tracking + LLM-assisted research; V1 is a
 *                    placeholder while we ship Money first)
 *
 * The post-sign-in chooser at `/account-type` lets the user pick a module
 * and remembers the last choice in localStorage for sticky deep-linking.
 * The AppHeader provides an in-place 3-segment switcher so the user can
 * flip modules at any time.
 *
 * Public:
 *   /            → SignIn (with brand mark)
 *   /sign-in     → redirect to /  (kept for backwards compat)
 *
 * Protected (require an authenticated Cognito session):
 *   /account-type             → 3-tile ModuleChooser
 *   /money                    → redirect to /money/dashboard
 *   /money/dashboard          → Money: YNAB-driven macro dashboard
 *   /investments              → Investments placeholder
 *   /business                 → redirect to /dashboard
 *   /personal, /personal/*    → legacy redirect to /money/dashboard
 *   /dashboard, /clients, ... → Business routes (flat URLs, the implicit default module)
 */
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Landing } from "@/routes/Landing";
import { SignIn } from "@/routes/SignIn";
import { AccountType } from "@/routes/AccountType";
import { MoneyDashboard } from "@/routes/MoneyDashboard";
import { Investments } from "@/routes/Investments";
import { InvestmentAccounts } from "@/routes/InvestmentAccounts";
import { NewHolding, EditHolding } from "@/routes/HoldingForm";
import { InvestmentTargets } from "@/routes/InvestmentTargets";
import { AccountContributions } from "@/routes/AccountContributions";
import { Clients } from "@/routes/Clients";
import { ClientDetail } from "@/routes/ClientDetail";
import { NewClient, EditClient } from "@/routes/ClientForm";
import { Timesheets } from "@/routes/Timesheets";
import { Invoices } from "@/routes/Invoices";
import { NewInvoice, EditInvoice } from "@/routes/InvoiceForm";
import { Payments } from "@/routes/Payments";
import { NewPayment, EditPayment } from "@/routes/PaymentForm";
import { Taxes } from "@/routes/Taxes";
import { NewTaxPayment, EditTaxPayment } from "@/routes/TaxPaymentForm";
import { LinkTaxInvoices } from "@/routes/LinkTaxInvoices";
import { Transfers } from "@/routes/Transfers";
import { NewTransfer, EditTransfer } from "@/routes/TransferForm";
import { Settings } from "@/routes/Settings";
import { Dashboard } from "@/routes/Dashboard";
import { Expenses } from "@/routes/Expenses";
import { ExpenseForm } from "@/routes/ExpenseForm";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ThemeSync } from "@/components/ThemeSync";

/**
 * Apex / www hostnames serve the personal landing page; all other hosts
 * (incl. `app.*`, the Amplify default domain, and localhost dev) serve
 * the application. The override `?landing=1` lets local dev preview the
 * landing without rebuilding for a different host.
 */
const LANDING_HOSTS = new Set(["vesselone.ca", "www.vesselone.ca"]);

function shouldShowLanding(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("landing") === "1") return true;
  if (params.get("landing") === "0") return false;
  return LANDING_HOSTS.has(window.location.hostname);
}

export function App() {
  if (shouldShowLanding()) {
    return <Landing />;
  }
  return (
    <BrowserRouter>
      <ThemeSync />
      <Routes>
        {/* Public */}
        <Route path="/" element={<SignIn />} />
        <Route path="/sign-in" element={<Navigate to="/" replace />} />

        {/* Protected */}
        <Route element={<ProtectedRoute />}>
          <Route path="/account-type" element={<AccountType />} />

          {/* Money module */}
          <Route
            path="/money"
            element={<Navigate to="/money/dashboard" replace />}
          />
          <Route path="/money/dashboard" element={<MoneyDashboard />} />

          {/* Investments module — portfolio tracker (V1). */}
          <Route path="/investments" element={<Investments />} />
          <Route
            path="/investments/accounts"
            element={<InvestmentAccounts />}
          />
          <Route
            path="/investments/accounts/:id/contributions"
            element={<AccountContributions />}
          />
          <Route
            path="/investments/holdings/new"
            element={<NewHolding />}
          />
          <Route
            path="/investments/holdings/:id"
            element={<EditHolding />}
          />
          <Route
            path="/investments/targets"
            element={<InvestmentTargets />}
          />

          {/* Legacy /personal/* — silent redirect into Money so any saved
              bookmarks or browser autocompletes keep working. */}
          <Route
            path="/personal"
            element={<Navigate to="/money/dashboard" replace />}
          />
          <Route
            path="/personal/*"
            element={<Navigate to="/money/dashboard" replace />}
          />

          {/* Business module — flat URLs are the implicit default. */}
          <Route
            path="/business"
            element={<Navigate to="/dashboard" replace />}
          />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/new" element={<NewClient />} />
          <Route path="/clients/:id" element={<ClientDetail />} />
          <Route path="/clients/:id/edit" element={<EditClient />} />
          <Route path="/timesheets" element={<Timesheets />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/invoices/:id" element={<EditInvoice />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/new" element={<NewPayment />} />
          <Route path="/payments/:id" element={<EditPayment />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/expenses/:id" element={<ExpenseForm />} />
          <Route path="/taxes" element={<Taxes />} />
          <Route path="/taxes/new" element={<NewTaxPayment />} />
          <Route path="/taxes/:id" element={<EditTaxPayment />} />
          <Route path="/taxes/:id/link" element={<LinkTaxInvoices />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/transfers/new" element={<NewTransfer />} />
          <Route path="/transfers/:id" element={<EditTransfer />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        {/* 404 */}
        <Route
          path="*"
          element={
            <main className="flex min-h-screen items-center justify-center">
              <div className="text-center">
                <h1 className="text-4xl font-bold">404</h1>
                <p className="mt-2 text-muted-foreground">Page not found.</p>
              </div>
            </main>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
