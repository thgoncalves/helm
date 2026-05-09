/**
 * App — root Router with all application routes.
 *
 * Route structure:
 *   /            → public landing page (brand + sign-in CTA)
 *   /sign-in     → public sign-in page
 *   /clients     → protected clients list (requires auth)
 *   *            → 404 fallback
 */
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Landing } from "@/routes/Landing";
import { SignIn } from "@/routes/SignIn";
import { Clients } from "@/routes/Clients";
import { ProtectedRoute } from "@/components/ProtectedRoute";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<Landing />} />
        <Route path="/sign-in" element={<SignIn />} />

        {/* Protected routes — wrapped in ProtectedRoute which renders <Outlet /> */}
        <Route element={<ProtectedRoute />}>
          <Route path="/clients" element={<Clients />} />
        </Route>


        {/* 404 fallback */}
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
