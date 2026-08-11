// web/src/pages/admin/students/applications/index.tsx

import React, { useState, useCallback } from "react";
import { useNavigate }                   from "react-router-dom";

import { useApplications, STALE_DAYS }   from "../../../../hooks/useApplications";
import { SummaryCard }                   from "../../../../components/applications/SummaryCard";
import { ApplicationCard }               from "../../../../components/applications/ApplicationCard";
import { ReviewModal }                   from "../../../../components/applications/ReviewModal";
import { EmptyState }                    from "../../../../components/applications/EmptyState";
import { ErrorBanner }                   from "../../../../components/applications/ErrorBanner";
import { Toast }                         from "../../../../components/applications/Toast";
import { Spinner }                       from "../../../../components/applications/Spinner";

import type {
  NormalisedApplication,
  ApprovalResult,
  ToastMessage,
} from "../../../../types/applications";

// ─── Tiny icon components ────────────────────────────────────────────────────

const SvgIcon: React.FC<{
  d:     string;
  color: string;
  size?: number;
  className?: string;
}> = ({ d, color, size = 20, className = "" }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d={d} />
  </svg>
);

const PATHS = {
  back:      "M19 12H5M12 19l-7-7 7-7",
  refresh:   "M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 115.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15",
  personAdd: "M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2M8.5 7a4 4 0 100-8 4 4 0 000 8zM20 8v6M23 11h-6",
  alert:     "M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  school:    "M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20",
} as const;

// ─── Safe field accessor ─────────────────────────────────────────────────────

const safeField = <T,>(
  obj: Record<string, T> | null | undefined,
  key: string
): T | null => {
  if (!obj || typeof obj !== "object") return null;
  const val = obj[key];
  return val !== undefined && val !== null ? val : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE HEADER
// ─────────────────────────────────────────────────────────────────────────────

interface PageHeaderProps {
  onBack:     () => void;
  onRefresh:  () => void;
  refreshing: boolean;
  subtitle:   string;
}

const PageHeader: React.FC<PageHeaderProps> = ({
  onBack,
  onRefresh,
  refreshing,
  subtitle,
}) => (
  <header
    className="flex items-center gap-3 px-5 pt-6 sm:pt-8 pb-4 bg-white
               border-b border-gray-100 flex-shrink-0"
  >
    <button
      onClick={onBack}
      className="w-10 h-10 rounded-xl bg-gray-100 flex items-center
                 justify-center hover:bg-gray-200 transition-colors
                 focus:outline-none focus:ring-2 focus:ring-gray-300"
      aria-label="Go back"
    >
      <SvgIcon d={PATHS.back} color="#111827" size={22} />
    </button>

    <div className="flex-1 min-w-0">
      <h1 className="text-xl font-bold text-gray-900 leading-tight">
        Applications
      </h1>
      <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
    </div>

    <button
      onClick={onRefresh}
      disabled={refreshing}
      className="w-10 h-10 rounded-xl bg-amber-100 flex items-center
                 justify-center hover:bg-amber-200 transition-colors
                 disabled:opacity-50 focus:outline-none focus:ring-2
                 focus:ring-amber-300"
      aria-label="Refresh applications"
    >
      <SvgIcon
        d={PATHS.refresh}
        color="#D97706"
        size={20}
        className={refreshing ? "animate-spin" : ""}
      />
    </button>
  </header>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

const StudentApplicationsPage: React.FC = () => {
  const navigate = useNavigate();

  const {
    applications,
    classes,
    staleCount,
    loading,
    refreshing,
    error,
    loadData,
    approve,
    reject,
  } = useApplications();

  const [selectedApplication, setSelectedApplication] =
    useState<NormalisedApplication | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  // ── Toast ───────────────────────────────────────────────────────────────
  const showToast = useCallback(
    (type: ToastMessage["type"], message: string) => {
      setToast({ type, message });
    },
    []
  );

  const dismissToast = useCallback(() => setToast(null), []);

  // ── Review modal ────────────────────────────────────────────────────────
  const openReview = useCallback(
    (app: NormalisedApplication) => setSelectedApplication(app),
    []
  );
  const closeReview = useCallback(
    () => setSelectedApplication(null),
    []
  );

  // ── Approve handler ─────────────────────────────────────────────────────
  const handleApprove = useCallback(
    async (applicationId: string, classId: string) => {
      const result = await approve(applicationId, classId);
      const app    = selectedApplication;
      const cls    = classes.find(
        (c) => String(c.id) === String(classId)
      );
      const className = cls?.name ?? "the selected class";

      closeReview();

      const warning = safeField(
        result as Record<string, unknown>,
        "warning"
      ) as string | null;
      const emailSent = safeField(
        result as Record<string, unknown>,
        "emailSent"
      ) as boolean | null;
      const tempPassword = safeField(
        result as Record<string, unknown>,
        "tempPassword"
      ) as string | null;

      if (warning) {
        showToast(
          "warning",
          `${app?.name} approved — no email sent. ${warning}`
        );
      } else if (emailSent === false && tempPassword) {
        try {
          await navigator.clipboard.writeText(tempPassword);
          showToast(
            "info",
            `${app?.name} approved. Email failed — password copied: ${tempPassword}`
          );
        } catch {
          showToast(
            "info",
            `${app?.name} approved. Email failed — temp password: ${tempPassword}`
          );
        }
      } else {
        showToast(
          "success",
          `${app?.name} approved and assigned to ${className}. Welcome email sent.`
        );
      }

      return result;
    },
    [approve, closeReview, selectedApplication, classes, showToast]
  );

  // ── Reject handler ──────────────────────────────────────────────────────
  const handleReject = useCallback(
    async (applicationId: string, reason: string) => {
      const app    = selectedApplication;
      const result = await reject(applicationId, reason);
      closeReview();
      showToast(
        "success",
        `${app?.name}'s application has been rejected.`
      );
      return result;
    },
    [reject, closeReview, selectedApplication, showToast]
  );

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <PageHeader
          onBack={() => navigate(-1)}
          onRefresh={() => loadData(true)}
          refreshing={false}
          subtitle="Loading…"
        />
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <Spinner size={40} color="#4F46E5" />
          <p className="text-sm text-gray-500 font-medium">
            Loading applications…
          </p>
        </div>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* ── Header ── */}
      <PageHeader
        onBack={() => navigate(-1)}
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
        subtitle={`${applications.length} ${
          applications.length === 1
            ? "pending application"
            : "pending applications"
        }`}
      />

      {/* ── Summary ── */}
      <div className="flex gap-2 px-5 pt-5 pb-2">
        <SummaryCard
          bg="#FEF3C7"
          icon={<SvgIcon d={PATHS.personAdd} color="#D97706" />}
          iconColor="#D97706"
          value={applications.length}
          label="Pending"
        />
        <SummaryCard
          bg="#FEE2E2"
          icon={<SvgIcon d={PATHS.alert} color="#DC2626" />}
          iconColor="#DC2626"
          value={staleCount}
          label={`Over ${STALE_DAYS}d`}
        />
        <SummaryCard
          bg="#EEF2FF"
          icon={<SvgIcon d={PATHS.school} color="#4F46E5" />}
          iconColor="#4F46E5"
          value={classes.length}
          label="Classes"
        />
      </div>

      {/* ── Content ── */}
      <main className="flex-1 overflow-y-auto px-5 pb-10 pt-2">

        {error && (
          <ErrorBanner message={error} onRetry={() => loadData()} />
        )}

        {applications.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
            {applications.map((app) => (
              <ApplicationCard
                key={app.id}
                application={app}
                onReview={openReview}
              />
            ))}
          </div>
        )}
      </main>

      {/* ── Review Modal ── */}
      {selectedApplication && (
        <ReviewModal
          application={selectedApplication}
          classes={classes}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={closeReview}
        />
      )}

      {/* ── Toast ── */}
      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onDismiss={dismissToast}
        />
      )}
    </div>
  );
};

export default StudentApplicationsPage;