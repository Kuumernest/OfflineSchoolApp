// web/src/App.tsx
//
// The route tree.
//
// This file used to be the untouched Vite starter component, which is why none
// of the ~25 pages in src/pages were reachable. Every page is now wired here.
//
// Two deliberate choices:
//
//   Lazy routes — each page is a separate chunk. The exam and settings pages
//   alone are >1000 lines each; loading all of them to render the login screen
//   is the difference between a fast first paint and a slow one.
//
//   One <Suspense> per route element rather than one around <Outlet/>. A
//   single boundary at the layout level would unmount the sidebar and topbar
//   on every navigation, making the whole shell flicker.

import { Suspense, lazy, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";

import ProtectedRoute   from "@/components/auth/ProtectedRoute";
import StaffOnly       from "@/components/auth/StaffOnly";
import RequireRole     from "@/components/auth/RequireRole";
import DashboardLayout  from "@/components/layout/DashboardLayout";
import RouteErrorBoundary from "@/components/layout/RouteErrorBoundary";
import { PageSpinner }  from "@/components/ui/Spinner";
import { useAuthStore } from "@/store/auth.store";
import { type UserRole } from "@/types";
import { retryImport } from "@/utils/lazyWithRetry";

// ─────────────────────────────────────────────────────────────────────────────
// LAZY PAGES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * React.lazy, with the chunk fetched again before giving up.
 *
 * A page imported straight through lazy crashed the route with "Failed to
 * fetch dynamically imported module" the first time one request for its chunk
 * failed. retryImport tries a few times with a short backoff; if the chunk is
 * really gone (a deploy renamed it), RouteErrorBoundary offers a reload.
 * Every page below goes through this — scripts/check-chunk-retry.mjs holds it.
 */
function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(() => retryImport(load));
}

const LoginPage        = lazyPage(() => import("@/pages/LoginPage"));
const ChangePassword   = lazyPage(() => import("@/pages/auth/ChangePasswordPage"));
const DashboardPage    = lazyPage(() => import("@/pages/dashboard/DashboardPage"));
const BursarDashboard  = lazyPage(() => import("@/pages/dashboard/BursarDashboardPage"));
const WatchlistPage    = lazyPage(() => import("@/pages/insights/watchlist"));
const ClassIntelPage   = lazyPage(() => import("@/pages/insights/class-intelligence"));
const IntelReviewPage  = lazyPage(() => import("@/pages/insights/intelligence-review"));
const StrengthsPage    = lazyPage(() => import("@/pages/insights/student-strengths"));

const StudentsPage     = lazyPage(() => import("@/pages/students/StudentsPage"));
const StudentDetail    = lazyPage(() => import("@/pages/students/StudentDetailPage"));
const AddStudentPage   = lazyPage(() => import("@/pages/students/AddStudentPage"));
const EditStudentPage  = lazyPage(() => import("@/pages/students/EditStudentPage"));
const AdmissionsPage   = lazyPage(() => import("@/pages/students/AdmissionsPage"));

const TeachersPage     = lazyPage(() => import("@/pages/teachers/TeachersPage"));
const AddTeacherPage   = lazyPage(() => import("@/pages/teachers/AddTeacherPage"));
const EditTeacherPage  = lazyPage(() => import("@/pages/teachers/EditTeacherPage"));

const AssignmentsPage  = lazyPage(() => import("@/pages/assignments/index"));
const AssignPage       = lazyPage(() => import("@/pages/assignments/assign"));
const AssignmentDetail = lazyPage(() => import("@/pages/assignments/[id]"));

const ClassesPage      = lazyPage(() => import("@/pages/classes/ClassesPage"));
const SubjectsPage     = lazyPage(() => import("@/pages/subjects/index"));
const AddSubjectPage   = lazyPage(() => import("@/pages/subjects/add/index"));
const EditSubjectPage  = lazyPage(() => import("@/pages/subjects/edit/index"));

const TimetablePage    = lazyPage(() => import("@/pages/timetable/index"));
const TimetableConflictsPage = lazyPage(() => import("@/pages/timetable/conflicts"));
const PeriodsPage      = lazyPage(() => import("@/pages/periods/index"));

const AttendancePage   = lazyPage(() => import("@/pages/attendance/index"));
const AttendanceReport = lazyPage(() => import("@/pages/attendance/reports/index"));

const ExamsPage        = lazyPage(() => import("@/pages/exams/index"));
const CreateExamPage   = lazyPage(() => import("@/pages/exams/create/index"));
const ExamDetailPage   = lazyPage(() => import("@/pages/exams/[id]/index"));
const ExamResultsPage  = lazyPage(() => import("@/pages/exams/results/index"));
const TermResultsPage  = lazyPage(() => import("@/pages/exams/term-results/index"));
const AnnualResultsPage = lazyPage(() => import("@/pages/exams/annual-results/index"));

const AnnouncementsPage = lazyPage(() => import("@/pages/announcements/index"));
const MessagesPage      = lazyPage(() => import("@/pages/messages/index"));
const MessageAuditPage  = lazyPage(() => import("@/pages/messages/audit"));

const ReportsOverview  = lazyPage(() => import("@/pages/reports/index"));
const ReportCardsPage  = lazyPage(() => import("@/pages/reports/cards"));
const TemplatesPage    = lazyPage(() => import("@/pages/reports/templates"));
const TemplateBuilder  = lazyPage(() => import("@/pages/reports/builder"));
const TemplatePreview  = lazyPage(() => import("@/pages/reports/preview"));

const SettingsPage     = lazyPage(() => import("@/pages/settings/SettingsPage"));

const ApprovalsPage    = lazyPage(() => import("@/pages/approvals/index"));
const FeesPage         = lazyPage(() => import("@/pages/fees/index"));
const FeeStructures    = lazyPage(() => import("@/pages/fees/structures"));
const StudentFees      = lazyPage(() => import("@/pages/fees/student"));
const ExpensesPage     = lazyPage(() => import("@/pages/finance/expenses"));
const SalariesPage     = lazyPage(() => import("@/pages/finance/salaries"));
const PayrollPage      = lazyPage(() => import("@/pages/finance/payroll"));
const FinanceReports   = lazyPage(() => import("@/pages/finance/reports"));
const PromotionPage    = lazyPage(() => import("@/pages/promotion/index"));
const ProgressionPage  = lazyPage(() => import("@/pages/promotion/progression"));
const DocumentsPage    = lazyPage(() => import("@/pages/documents/index"));
const ExportsPage      = lazyPage(() => import("@/pages/exports/index"));
const PortalCodesPage  = lazyPage(() => import("@/pages/portal/codes"));
const ParentPortalPage = lazyPage(() => import("@/pages/portal/index"));
const VerifyPage       = lazyPage(() => import("@/pages/verify/index"));
const NotFoundPage     = lazyPage(() => import("@/pages/NotFoundPage"));

// The platform: above any school. super_admin only — see navigation.ts.
const PlatformDashboard    = lazyPage(() => import("@/pages/platform/PlatformDashboardPage"));
const PlatformSchools      = lazyPage(() => import("@/pages/platform/SchoolsPage"));
const PlatformSchoolDetail = lazyPage(() => import("@/pages/platform/SchoolDetailPage"));
const PlatformPerformance  = lazyPage(() => import("@/pages/platform/PerformancePage"));
const PlatformReports      = lazyPage(() => import("@/pages/platform/ReportsPage"));
const PlatformAudit        = lazyPage(() => import("@/pages/platform/AuditLogPage"));
const PlatformSettings     = lazyPage(() => import("@/pages/platform/PlatformSettingsPage"));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps a lazy page in its own Suspense + error boundary.
 *
 * The boundary is per-route on purpose: a page that throws should show a
 * recoverable error inside the dashboard shell, not blank the whole app.
 */
const page = (node: React.ReactNode) => (
  <RouteErrorBoundary>
    <Suspense fallback={<PageSpinner />}>{node}</Suspense>
  </RouteErrorBoundary>
);

// ─────────────────────────────────────────────────────────────────────────────
// ROLE GROUPS
//
// These mirror the sets in backend/src/config/roles.js, name for name, and are
// the second half of an authorisation decision the server has already made.
// The server is the authority; what these buy is that a person who types a URL
// they may not have gets told so, rather than getting a rendered page whose
// every request then fails with a 403.
//
// Keep a group here identical to the guard on the matching router. Where they
// disagree, the server wins and the user sees a broken screen — which is the
// exact failure this is here to remove.
// ─────────────────────────────────────────────────────────────────────────────

/** Governance, configuration, academic authority, approval. */
const ADMIN: UserRole[] = ["super_admin", "school_admin"];

/** The ledger. Admins stay in because they are the ones who approve. */
const FINANCE: UserRole[] = ["super_admin", "school_admin", "bursar"];

/** The office rather than the staffroom: deals with parents and money. */
const OFFICE: UserRole[] = ["super_admin", "school_admin", "bursar"];

/** Academic work. The bursar is deliberately absent. */
const TEACHING: UserRole[] = ["super_admin", "school_admin", "teacher"];

/** Anyone the school employs. Reads, and messages. */
const STAFF: UserRole[] = ["super_admin", "school_admin", "bursar", "teacher"];

/** Above any school: the operator of the deployment. Mirrors PLATFORM_ROLES. */
const PLATFORM: UserRole[] = ["super_admin"];

/** Wraps a group of routes in one role gate. */
const gate = (roles: UserRole[]) => (
  <RequireRole roles={roles}>
    <Outlet />
  </RequireRole>
);

/**
 * /dashboard is one path and two pages.
 *
 * A bursar opening the admin dashboard would get eight simultaneous 403s — it
 * reads enrolment, exam, attendance and admission endpoints, none of which they
 * may touch. They get a page about money instead.
 *
 * Resolved here rather than by giving the bursar their own path, so that the
 * sidebar entry, the post-login redirect and every "back to dashboard" link in
 * the app keep working without any of them knowing the role.
 */
function DashboardHome() {
  const role         = useAuthStore((s) => s.user?.role);
  const activeSchool = useAuthStore((s) => s.activeSchool);
  // The operator lands on the platform until they step into a school; inside
  // one they get that school's dashboard like its own administrator would.
  if (role === "super_admin" && !activeSchool) return <Navigate to="/platform" replace />;
  return role === "bursar" ? <BursarDashboard /> : <DashboardPage />;
}

/** Sends an already-signed-in user away from /login instead of showing it. */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const token          = useAuthStore((s) => s.token);
  const hasInitialized = useAuthStore((s) => s.hasInitialized);

  if (!hasInitialized) return <PageSpinner />;
  if (token)           return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>

      {/* ── Public ────────────────────────────────────────────────────────── */}
      <Route
        path="/login"
        element={<PublicOnly>{page(<LoginPage />)}</PublicOnly>}
      />

      {/*
        The guardian portal. Public, and deliberately NOT wrapped in
        PublicOnly: that guard redirects anyone holding a staff session away
        from the page, which would stop a bursar checking what a parent sees on
        their own screen. The portal carries its own token and its own sign-in,
        so a staff session here is simply irrelevant rather than a conflict.
      */}
      {/* Its sections are paths under it (/portal/results, /attendance,
          /fees, /messages — utils/portalRoutes), so a refresh or a link lands
          on the section, and back/forward moves between them. */}
      <Route path="/portal/*" element={page(<ParentPortalPage />)} />

      {/* Where a printed document's QR code points; public, like the portal. */}
      <Route path="/verify"       element={page(<VerifyPage />)} />
      <Route path="/verify/:code" element={page(<VerifyPage />)} />

      {/* ── Authenticated ─────────────────────────────────────────────────── */}
      <Route element={<ProtectedRoute />}>

        {/* Sits outside the dashboard shell: a user who must reset their
            password should not be able to reach the nav behind it. */}
        <Route path="/change-password" element={page(<ChangePassword />)} />

        {/*
          The console is staff-only. Every page below reads from /admin/* or a
          staff-scoped teacher route, so a student token 403s on all of them.
          The gate is outside DashboardLayout so a student never renders the
          shell at all; /change-password above stays reachable for them.
        */}
        <Route element={<StaffOnly><DashboardLayout /></StaffOnly>}>

          <Route index element={<Navigate to="/dashboard" replace />} />

          {/* ── The platform: above any school ─────────────────────────── */}
          <Route element={gate(PLATFORM)}>
            <Route path="/platform"                   element={page(<PlatformDashboard />)} />
            <Route path="/platform/schools"           element={page(<PlatformSchools />)} />
            <Route path="/platform/schools/:schoolId" element={page(<PlatformSchoolDetail />)} />
            <Route path="/platform/performance"       element={page(<PlatformPerformance />)} />
            <Route path="/platform/reports"           element={page(<PlatformReports />)} />
            <Route path="/platform/audit"             element={page(<PlatformAudit />)} />
            <Route path="/platform/settings"          element={page(<PlatformSettings />)} />
          </Route>

          {/* Every member of staff has a dashboard; which one is by role. */}
          <Route element={gate(STAFF)}>
            <Route path="/dashboard" element={page(<DashboardHome />)} />
            <Route path="/exports"   element={page(<ExportsPage />)} />

            {/* The bursar sends fee reminders and payment confirmations from
                here. /messages/audit is under ADMIN below: sending a message
                and reading someone else's are separate rights, and the API
                draws the same line. */}
            <Route path="/messages"  element={page(<MessagesPage />)} />
          </Route>

          {/* ── The office: parents and money ──────────────────────────── */}
          <Route element={gate(OFFICE)}>
            {/*
              Both audiences, one route. A head teacher sees the school's queue
              with Approve and Reject; a bursar sees the requests they raised and
              can only withdraw them. The server decides which, from
              approvals.decide — so the gate here is only "is this your business
              at all", and OFFICE is exactly that set.
            */}
            <Route path="/approvals" element={page(<ApprovalsPage />)} />

            {/* Named by fee arrears, so teachers are out and the bursar is in.
                Read-only — the endpoint has no write route at all. */}
            <Route path="/watchlist" element={page(<WatchlistPage />)} />
          </Route>

          {/* ── The ledger ─────────────────────────────────────────────── */}
          <Route element={gate(FINANCE)}>
            {/* Fees: money coming in. The arrears list is the landing screen;
                structures and a single student's ledger hang off it. */}
            <Route path="/fees" element={page(<FeesPage />)} />
            <Route path="/fees/structures" element={page(<FeeStructures />)} />
            <Route path="/fees/students/:studentId" element={page(<StudentFees />)} />

            {/* Finance: money going out. Kept apart from /fees so a bursar
                reconciling receipts is never one mis-click from payroll.

                /finance/salaries is here rather than under ADMIN because the
                bursar must read a salary to pay it. The New button on that page
                posts to an admin-only endpoint and will 403 for them, which is
                the intended boundary: preparing the payroll is theirs, setting
                what somebody earns is not. */}
            <Route path="/finance/expenses" element={page(<ExpensesPage />)} />
            <Route path="/finance/salaries" element={page(<SalariesPage />)} />
            <Route path="/finance/payroll" element={page(<PayrollPage />)} />
            <Route path="/finance/reports" element={page(<FinanceReports />)} />
          </Route>

          {/* ── Academic work ──────────────────────────────────────────── */}
          <Route element={gate(TEACHING)}>
            {/*
              The student intelligence pages are the staffroom's, and the
              navigation has always offered them to teachers — but they sat in
              the OFFICE gate, where a teacher who followed the link was turned
              back. The API decides the rest: insights.viewTaught is a TEACHING
              capability and every pupil route scopes a teacher to their own
              classes (a pupil outside them is 403), so this gate is only "is
              this your business at all". The bursar is out, as on the API.
            */}
            {/* The teacher loop: evidence → guidance → action → outcome. */}
            <Route path="/class-intelligence" element={page(<ClassIntelPage />)} />
            {/* Calibration: a teacher judges what the engine said, without seeing
                what colleagues said until they have answered themselves. */}
            <Route path="/intelligence-review" element={page(<IntelReviewPage />)} />
            {/* Strengths, exploration and the explanation layer, one pupil. */}
            <Route path="/students/:studentId/strengths" element={page(<StrengthsPage />)} />

            {/* Students. The bursar may read a student record through the API
                but not here: these are the admission and approval screens, and
                they read from /admin/students, which is admin-only. */}
            <Route path="/students"              element={page(<StudentsPage />)} />
            <Route path="/students/new"          element={page(<AddStudentPage />)} />
            {/* Last: ":id" would otherwise swallow "new" / "admissions". */}
            <Route path="/students/:id"          element={page(<StudentDetail />)} />
            <Route path="/students/:id/edit"     element={page(<EditStudentPage />)} />

            <Route path="/subjects"          element={page(<SubjectsPage />)} />
            <Route path="/subjects/add"      element={page(<AddSubjectPage />)} />
            <Route path="/subjects/edit/:id" element={page(<EditSubjectPage />)} />
            <Route path="/timetable"         element={page(<TimetablePage />)} />
            <Route path="/timetable/conflicts" element={page(<TimetableConflictsPage />)} />

            <Route path="/attendance"         element={page(<AttendancePage />)} />
            <Route path="/attendance/reports" element={page(<AttendanceReport />)} />

            <Route path="/exams"         element={page(<ExamsPage />)} />
            <Route path="/exams/new"     element={page(<CreateExamPage />)} />
            <Route path="/exams/results" element={page(<ExamResultsPage />)} />
            <Route path="/exams/term-results" element={page(<TermResultsPage />)} />
            <Route path="/exams/annual-results" element={page(<AnnualResultsPage />)} />
            {/* Report cards used to live here. They are one section under
                /reports now; this keeps old links and bookmarks working. */}
            <Route path="/exams/reports" element={<Navigate to="/reports/cards" replace />} />
            <Route path="/exams/:id"     element={page(<ExamDetailPage />)} />

            <Route path="/announcements" element={page(<AnnouncementsPage />)} />

            {/* Printing desk: class lists, ID cards and transcripts — academic
                documents. A receipt or a fee statement prints from /fees. */}
            <Route path="/documents" element={page(<DocumentsPage />)} />
          </Route>

          {/* ── Governance, configuration, academic authority ───────────── */}
          <Route element={gate(ADMIN)}>
            {/* Admission and application screens: students.admit is an ADMIN
                capability on the server, and the navigation lists them for
                administrators only; a teacher reaching them by URL met 403s. */}
            <Route path="/students/admissions"   element={page(<AdmissionsPage />)} />
            {/* One screen, one name (C7): applications are reviewed under
                Admissions. The old address still lands there. */}
            <Route path="/students/applications" element={<Navigate to="/students/admissions" replace />} />
            <Route path="/teachers"                    element={page(<TeachersPage />)} />
            <Route path="/teachers/new"                element={page(<AddTeacherPage />)} />
            <Route path="/teachers/assignments"        element={page(<AssignmentsPage />)} />
            <Route path="/teachers/assignments/assign" element={page(<AssignPage />)} />
            <Route path="/teachers/assignments/:id"    element={page(<AssignmentDetail />)} />
            <Route path="/teachers/:id/edit"           element={page(<EditTeacherPage />)} />

            <Route path="/classes" element={page(<ClassesPage />)} />
            <Route path="/periods" element={page(<PeriodsPage />)} />

            {/* Reading a thread you are not part of is recorded server-side and
                is the strongest right in the messaging module. Admins only. */}
            <Route path="/messages/audit" element={page(<MessageAuditPage />)} />

            {/* Report-card configuration: the template every card in the school
                is rendered from. */}
            <Route path="/reports"           element={page(<ReportsOverview />)} />
            <Route path="/reports/cards"     element={page(<ReportCardsPage />)} />
            <Route path="/reports/templates" element={page(<TemplatesPage />)} />
            <Route path="/reports/builder"   element={page(<TemplateBuilder />)} />
            <Route path="/reports/preview"   element={page(<TemplatePreview />)} />

            {/* End-of-year rollover. Progression must be set before a run can
                place anybody. */}
            <Route path="/promotion" element={page(<PromotionPage />)} />
            <Route path="/promotion/progression" element={page(<ProgressionPage />)} />

            {/* Issuing a guardian code hands out credentials. */}
            <Route path="/portal-codes" element={page(<PortalCodesPage />)} />

            <Route path="/settings" element={page(<SettingsPage />)} />
          </Route>
        </Route>
      </Route>

      {/* Catch-all outside ProtectedRoute so unauthenticated unknown URLs
          show a 404 instead of a blank page. */}
      <Route path="*" element={page(<NotFoundPage />)} />
    </Routes>
  );
}
