// web/src/components/auth/StaffOnly.tsx
//
// The web console is for staff. Every page in it reads from /admin/* or the
// staff-scoped teacher routes, all of which answer 403 for a student — so a
// student who signed in here previously got a dashboard of failed requests, an
// empty timetable, and an "Not authorized" announcements page, with no
// indication that any of it was expected.
//
// This is deliberately a thin gate rather than a rewrite: the routes still
// exist, and if a student experience is built for the web later, deleting this
// component and restoring the "student" role in config/navigation.ts is all it
// takes to open the console back up.
//
// It wraps the dashboard shell only. /login and /change-password stay reachable
// for students, because a student may well follow a password-setup link here
// even though the console itself is not for them.

import { Navigate } from "react-router-dom";
import { GraduationCap, Smartphone, LogOut } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import { useAuthStore } from "@/store/auth.store";
import { type UserRole } from "@/types";

// The bursar is staff. This gate answers one question — is the console for
// this person at all — and which parts of it they get is decided by the rail in
// config/navigation.ts and by RequireRole on the routes themselves.
const STAFF: UserRole[] = ["super_admin", "school_admin", "bursar", "teacher"];
const STAFF_ROLES = new Set<string>(STAFF);

export default function StaffOnly({ children }: { children: React.ReactNode }) {
  const { t }          = useTranslation();
  const user           = useAuthStore((s) => s.user);
  const hasInitialized = useAuthStore((s) => s.hasInitialized);
  const logout         = useAuthStore((s) => s.logout);

  if (!hasInitialized) return <PageSpinner />;

  // No user at all is ProtectedRoute's business, not ours.
  if (!user) return <Navigate to="/login" replace />;

  if (STAFF_ROLES.has(user.role)) return <>{children}</>;

  // A student who still has to choose a password should finish that first —
  // otherwise they land here and cannot act on the email that sent them.
  if (user.mustResetPassword) {
    return <Navigate to="/change-password" replace />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <Card className="max-w-md text-center">
        <div className="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center mx-auto">
          <GraduationCap className="w-6 h-6 text-primary-600" />
        </div>

        {/*
          The name is interpolated into the greeting rather than concatenated
          around it: French puts the comma and the vocative differently, and a
          sentence assembled from three JSX fragments cannot be reordered by a
          translator.
        */}
        <h1 className="mt-4 text-base font-semibold text-ink">
          {t("staffOnly.greeting", {
            name: user.name ? `, ${user.name.split(" ")[0]}` : "",
          })}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {t("staffOnly.explain")}
        </p>

        <div className="mt-5 flex items-start gap-2.5 px-3 py-3 rounded-lg bg-primary-50/60 border border-primary-200 text-left">
          <Smartphone className="w-4 h-4 text-primary-600 shrink-0 mt-0.5" />
          <p className="text-xs text-primary-900">
            {t("staffOnly.useApp", {
              enrollment: user.enrollmentNo ? ` (${user.enrollmentNo})` : "",
            })}
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="mt-5"
          icon={<LogOut className="w-4 h-4" />}
          onClick={logout}
        >
          {t("staffOnly.signOut")}
        </Button>
      </Card>
    </div>
  );
}
