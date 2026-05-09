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
import { ProtectedRoute } from "@/components/ProtectedRoute";

export function App() {
  return (
    <BrowserRouter>
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
