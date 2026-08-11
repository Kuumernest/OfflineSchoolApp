// web/src/components/auth/ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore }     from "@/store/auth.store";
import { PageSpinner }      from "@/components/ui/Spinner";

export default function ProtectedRoute() {
  const token          = useAuthStore((s) => s.token);
  const hasInitialized = useAuthStore((s) => s.hasInitialized);

  // ── Still reading from storage ─────────────────────────
  // initAuth() is synchronous so this should resolve before
  // the first render in almost all cases.
  // The spinner is a safety net for any edge case where
  // the store hasn't been initialized yet.
  if (!hasInitialized) {
    return <PageSpinner />;
  }

  // ── No valid session — redirect to login ───────────────
  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // ── Authenticated — render child routes ───────────────
  return <Outlet />;
}