// web/src/components/auth/StaffOnly.tsx
//
// The web console is for the school office: the head, the administrators and
// the bursar. Teachers and students use the phone app.
//
// This is the ONE place that decides it. It wraps the dashboard shell inside
// ProtectedRoute, so every protected URL — /, /students/new, /exams/new, a deep
// link to an exam — passes through it before any page renders: a teacher gets
// the screen below, never a flash of the page behind it. No page checks for
// itself.
//
// Teachers used to be let in, and met a console built for the office: empty
// class pickers, raw 403 messages from /admin/* endpoints, dashboard tiles
// reading zero, and quick actions they cannot perform. Students were already
// sent away; both now get the same screen, worded for who they are, with the
// download links (config/mobileApp.ts) and a Sign out button.
//
// /login and /change-password stay outside it: a teacher on a temporary
// password sets it here first, then lands on this screen. The parent portal
// (/portal) has its own sign-in and never reaches it.

import { Navigate } from "react-router-dom";
import { GraduationCap, Smartphone, LogOut, Download } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import { useAuthStore } from "@/store/auth.store";
import { type UserRole } from "@/types";
import { MOBILE_APP_LINKS } from "@/config/mobileApp";

// The office. This gate answers one question — is the console for this person
// at all — and which parts of it they get is decided by the rail in
// config/navigation.ts and by RequireRole on the routes themselves. The
// bursar is office staff and keeps the console; a teacher does not.
const STAFF: UserRole[] = ["super_admin", "school_admin", "bursar"];
const STAFF_ROLES = new Set<string>(STAFF);

export default function StaffOnly({ children }: { children: React.ReactNode }) {
  const { t }          = useTranslation();
  const user           = useAuthStore((s) => s.user);
  const hasInitialized = useAuthStore((s) => s.hasInitialized);
  const logout         = useAuthStore((s) => s.logout);

  if (!hasInitialized) return <PageSpinner />;

  // No user at all is ProtectedRoute's business, not ours.
  if (!user) return <Navigate to="/login" replace />;

  // ── Anybody still on a temporary password finishes that first ───────────
  //
  // Above the staff check, and that ordering is the fix. This used to sit
  // BELOW it, so the branch was unreachable for the only people who could get
  // into the console: staff were handed their children and the flag was never
  // consulted. A bursar created with a temporary password was prompted to
  // change it by exactly one thing — an effect on LoginPage — which fires only
  // while that page is mounted. Reload the console, open a bookmarked URL,
  // restore a saved session, or navigate away from /change-password, and they
  // carried on with the temporary password indefinitely, with nothing to come
  // back and ask again.
  //
  // /change-password sits outside this gate, so there is no loop, and the page
  // clears the flag before it navigates on.
  if (user.mustResetPassword) {
    return <Navigate to="/change-password" replace />;
  }

  if (STAFF_ROLES.has(user.role)) return <>{children}</>;

  // Teachers and students: the same screen, worded for each.
  const who = user.role === "teacher" ? "teacher" : "student";
  const { android, ios } = MOBILE_APP_LINKS;

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <Card className="w-full max-w-md text-center">
        <div className="w-12 h-12 rounded-xl bg-primary-50 flex items-center justify-center mx-auto">
          <GraduationCap className="w-6 h-6 text-primary-600" aria-hidden="true" />
        </div>

        {/* The name is interpolated rather than concatenated: French places
            the comma and the vocative differently. */}
        <h1 className="mt-4 text-lg font-semibold text-ink">
          {t(`staffOnly.${who}.title`)}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {t("staffOnly.greeting", { name: user.name ? `, ${user.name.split(" ")[0]}` : "" })}
        </p>
        <p className="mt-3 text-sm text-ink-body">
          {t(`staffOnly.${who}.explain`)}
        </p>

        <div className="mt-5 flex items-start gap-2.5 px-3 py-3 rounded-lg bg-primary-50/60 border border-primary-200 text-left">
          <Smartphone className="w-4 h-4 text-primary-600 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-xs text-primary-900">
            {t(`staffOnly.${who}.useApp`, {
              enrollment: user.enrollmentNo ? ` (${user.enrollmentNo})` : "",
            })}
          </p>
        </div>

        {/* Download links from the deployment's configuration; none
            configured, the screen says where to ask instead. */}
        {android || ios ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
            {android && (
              <a href={android} target="_blank" rel="noopener noreferrer"
                 className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700">
                <Download className="h-4 w-4" aria-hidden="true" />
                {t("staffOnly.getAndroid")}
              </a>
            )}
            {ios && (
              <a href={ios} target="_blank" rel="noopener noreferrer"
                 className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700">
                <Download className="h-4 w-4" aria-hidden="true" />
                {t("staffOnly.getIos")}
              </a>
            )}
          </div>
        ) : (
          <p className="mt-4 text-xs text-ink-muted">{t("staffOnly.askOffice")}</p>
        )}

        <Button
          variant="secondary"
          className="mt-5 w-full sm:w-auto"
          icon={<LogOut className="w-4 h-4" />}
          onClick={logout}
        >
          {t("staffOnly.signOut")}
        </Button>
      </Card>
    </main>
  );
}
