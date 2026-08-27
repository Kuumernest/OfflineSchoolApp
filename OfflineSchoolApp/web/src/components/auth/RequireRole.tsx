// web/src/components/auth/RequireRole.tsx
//
// A role gate for a route, which the console did not have.
//
// Until now the only authorisation in the web app was the sidebar: an entry in
// config/navigation.ts listed the roles that could see the link, and that was
// it. A teacher who typed /settings into the address bar rendered the settings
// page in full and then watched every request inside it fail with a 403 —
// blank cards, spinners that never resolve, and a save button that throws.
// Hiding a link is presentation; it is not access control.
//
// That mattered less when every staff role could reach most of the API. With a
// bursar it matters a lot: /settings, /promotion and /reports/templates are
// specifically what the role exists to be kept out of, and a page that renders
// its own shell before failing looks like a broken app rather than a boundary.
//
// So this is presentation too — the server is still the authority, and every
// route below is guarded there as well. What this adds is an honest answer
// instead of a broken screen.

import { Navigate } from "react-router-dom";
import { ShieldAlert, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import { useAuthStore } from "@/store/auth.store";
import { type UserRole } from "@/types";

export default function RequireRole({
  roles,
  children,
}: {
  /** Who may see this route. Keep it identical to the guard on the API. */
  roles: UserRole[];
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const hasInitialized = useAuthStore((s) => s.hasInitialized);

  if (!hasInitialized) return <PageSpinner />;

  // No session at all is ProtectedRoute's business; not being staff is
  // StaffOnly's. Both sit above this component in the tree.
  if (!user) return <Navigate to="/login" replace />;

  // Set<string> rather than roles.includes(): AuthUser.role is a plain string
  // off the wire, while the prop is a UserRole[] so that call sites are checked.
  if (new Set<string>(roles).has(user.role)) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <Card className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-warning-soft">
          <ShieldAlert className="h-6 w-6 text-warning" aria-hidden="true" />
        </div>

        <h1 className="mt-4 text-base font-semibold text-ink">
          {t("requireRole.title")}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {t("requireRole.explain")}
        </p>

        {/*
          Navigates rather than going back in history: a user who landed here by
          typing the address has nothing useful behind them, and history.back()
          on a fresh tab does nothing at all.
        */}
        <Button
          variant="secondary"
          size="sm"
          className="mt-5"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => { window.location.assign("/dashboard"); }}
        >
          {t("requireRole.backToDashboard")}
        </Button>
      </Card>
    </div>
  );
}
