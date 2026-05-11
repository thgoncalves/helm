/**
 * App — root Router with all application routes.
 *
 * Public:
 *   /            → SignIn (with brand mark)
 *   /sign-in     → redirect to /  (kept for backwards compat)
 *
 * Protected (require an authenticated Cognito session):
 *   /account-type     → choose Personal or Business
 *   /personal         → Personal dashboard placeholder
 *   /business         → redirect to /clients
 *   /clients          → Clients list
 *   /clients/new      → New client form
 *   /clients/:id      → Client detail (read-only)
 *   /clients/:id/edit → Edit client form
 *
 * The post-sign-in flow is: SignIn → /account-type → /personal | /business.
 */
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SignIn } from "@/routes/SignIn";
import { AccountType } from "@/routes/AccountType";
import { Personal } from "@/routes/Personal";
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
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ThemeSync } from "@/components/ThemeSync";

export function App() {
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
          <Route path="/personal" element={<Personal />} />
          <Route
            path="/business"
            element={<Navigate to="/clients" replace />}
          />
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
