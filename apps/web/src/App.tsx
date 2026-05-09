/**
 * App — root Router with all application routes.
 *
 * Public:
 *   /            → SignIn (with brand mark)
 *   /sign-in     → redirect to /  (kept for backwards compat)
 *
 * Protected (require an authenticated Cognito session):
 *   /account-type → choose Personal or Business
 *   /personal     → Personal dashboard placeholder
 *   /business     → redirect to /clients (the only Business page so far)
 *   /clients      → Clients list (existing)
 *
 * The post-sign-in flow is: SignIn → /account-type → /personal | /business.
 */
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SignIn } from "@/routes/SignIn";
import { AccountType } from "@/routes/AccountType";
import { Personal } from "@/routes/Personal";
import { Clients } from "@/routes/Clients";
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
