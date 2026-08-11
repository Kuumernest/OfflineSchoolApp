// web/src/components/applications/ReviewModal.tsx

import React, { useCallback, useState, useEffect, useRef } from "react";
import { DetailRow }                    from "./DetailRow";
import { DocumentCard }                 from "./DocumentCard";
import { ClassPicker }                  from "./ClassPicker";
import { Spinner }                      from "./Spinner";
import { formatDate }                   from "../../utils/formatDate";

import type {
  NormalisedApplication,
  ApplicationDocument,
  ClassOption,
  ApprovalResult,
  RejectionResult,
} from "../../types/applications";

// ─── Icon helper ─────────────────────────────────────────────────────────────

const SvgIcon: React.FC<{
  d:     string;
  color: string;
  size?: number;
}> = ({ d, color, size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="flex-shrink-0"
  >
    <path d={d} />
  </svg>
);

const PATHS = {
  person:    "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4-4v2M12 7a4 4 0 100-8 4 4 0 000 8z",
  mail:      "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
  phone:     "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z",
  people:    "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2M9 7a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  home:      "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
  docText:   "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  school:    "M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20",
  calendar:  "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
  close:     "M18 6L6 18M6 6l12 12",
  docEmpty:  "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
  chat:      "M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z",
  closeCirc: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z",
  checkCirc: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
} as const;

// ─── Section wrappers ────────────────────────────────────────────────────────

const Section: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <div
    className={`bg-white rounded-2xl border border-gray-200 p-4 mb-3 ${className}`}
  >
    {children}
  </div>
);

const SectionHeader: React.FC<{
  icon:     React.ReactNode;
  title:    string;
  suffix?:  React.ReactNode;
}> = ({ icon, title, suffix }) => (
  <div className="flex items-center gap-2 mb-4">
    {icon}
    <h3 className="text-[15px] font-bold text-gray-900">{title}</h3>
    {suffix}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewModalProps {
  application: NormalisedApplication;
  classes:     ClassOption[];
  onApprove:   (applicationId: string, classId: string) => Promise<ApprovalResult>;
  onReject:    (applicationId: string, reason: string)  => Promise<RejectionResult>;
  onClose:     () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({
  application,
  classes,
  onApprove,
  onReject,
  onClose,
}) => {
  const [selectedClassId, setSelectedClassId] = useState<string | null>(
    application.classId ? String(application.classId) : null
  );
  const [rejectReason,    setRejectReason]    = useState("");
  const [pickerOpen,      setPickerOpen]      = useState(false);
  const [approving,       setApproving]       = useState(false);
  const [rejecting,       setRejecting]       = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  const isBusy = approving || rejecting;

  const selectedClass = classes.find(
    (c) => String(c.id) === String(selectedClassId)
  ) ?? null;

  // ── Trap focus & handle Escape ──────────────────────────────────────────
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isBusy) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [isBusy, onClose]);

  // ── Close picker when clicking outside ──────────────────────────────────
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-class-picker]")) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // ── Open document in new tab ────────────────────────────────────────────
  const openDocument = useCallback((doc: ApplicationDocument) => {
    const uri = doc.uri || doc.url || doc.fileUrl || doc.path;
    if (!uri) {
      alert("No document link available.");
      return;
    }
    window.open(uri, "_blank", "noopener,noreferrer");
  }, []);

  // ── Approve ─────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!selectedClassId) {
      setError("Please select a class before approving.");
      return;
    }
    const msg = `Approve ${application.name} and assign them to "${selectedClass?.name}"?`;
    if (!window.confirm(msg)) return;

    try {
      setError(null);
      setApproving(true);
      await onApprove(application.id, selectedClassId);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      setError(e?.response?.data?.message || e?.message || "Approval failed.");
    } finally {
      setApproving(false);
    }
  };

  // ── Reject ──────────────────────────────────────────────────────────────
  const handleReject = async () => {
    const msg = `Reject ${application.name}'s application? This cannot be undone.`;
    if (!window.confirm(msg)) return;

    try {
      setError(null);
      setRejecting(true);
      await onReject(application.id, rejectReason);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      setError(e?.response?.data?.message || e?.message || "Rejection failed.");
    } finally {
      setRejecting(false);
    }
  };

  // ── Backdrop click ──────────────────────────────────────────────────────
  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isBusy) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center
                 justify-center bg-gray-900/50 p-0 sm:p-4"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div
        ref={modalRef}
        className="relative w-full sm:max-w-xl bg-gray-50 rounded-t-3xl
                   sm:rounded-2xl max-h-[92dvh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle (mobile) */}
        <div className="w-10 h-1.5 bg-gray-300 rounded-full mx-auto mt-3 sm:hidden" />

        {/* ── Header ── */}
        <div className="flex items-center px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex-1">
            <h2
              id="review-modal-title"
              className="text-xl font-bold text-gray-900"
            >
              Review Application
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Approve or reject this application
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="w-9 h-9 rounded-xl bg-white border border-gray-200
                       flex items-center justify-center hover:bg-gray-100
                       transition-colors disabled:opacity-40 focus:outline-none
                       focus:ring-2 focus:ring-gray-300"
            aria-label="Close"
          >
            <SvgIcon d={PATHS.close} color="#6B7280" size={20} />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-5 pt-4 pb-6">
          {/* Error */}
          {error && (
            <div
              className="flex items-center gap-2 bg-red-50 border border-red-200
                         rounded-xl px-4 py-3 mb-3"
              role="alert"
            >
              <span className="text-red-600 text-sm font-medium flex-1">
                {error}
              </span>
              <button
                onClick={() => setError(null)}
                className="text-red-400 hover:text-red-600 focus:outline-none"
                aria-label="Dismiss error"
              >
                <SvgIcon d={PATHS.close} color="currentColor" size={16} />
              </button>
            </div>
          )}

          {/* ── Student Details ── */}
          <Section>
            <SectionHeader
              icon={<SvgIcon d={PATHS.person} color="#4F46E5" size={16} />}
              title="Student Details"
            />
            <DetailRow
              icon={<SvgIcon d={PATHS.person}   color="#D97706" />}
              label="Full Name"
              value={application.name}
            />
            <DetailRow
              icon={<SvgIcon d={PATHS.mail}     color="#4F46E5" />}
              label="Email Address"
              value={application.email || "No email provided"}
            />
            <DetailRow
              icon={<SvgIcon d={PATHS.phone}    color="#059669" />}
              label="Phone Number"
              value={application.phone}
            />
            <DetailRow
              icon={<SvgIcon d={PATHS.people}   color="#4F46E5" />}
              label="Guardian / Parent"
              value={application.guardianName}
            />
            {application.address && (
              <DetailRow
                icon={<SvgIcon d={PATHS.home}   color="#6B7280" />}
                label="Address"
                value={application.address}
              />
            )}
            {application.notes && (
              <DetailRow
                icon={<SvgIcon d={PATHS.docText} color="#6B7280" />}
                label="Notes"
                value={application.notes}
              />
            )}
            <DetailRow
              icon={<SvgIcon d={PATHS.school}   color="#7C3AED" />}
              label="Applied for Class"
              value={application.className || "Not specified"}
            />
            <DetailRow
              icon={<SvgIcon d={PATHS.calendar} color="#4F46E5" />}
              label="Applied On"
              value={formatDate(application.created_at)}
            />
          </Section>

          {/* ── Documents ── */}
          <Section>
            <SectionHeader
              icon={<SvgIcon d={PATHS.docText} color="#059669" size={16} />}
              title="Documents"
            />
            {application.documents.length > 0 ? (
              application.documents.map((doc, i) => (
                <DocumentCard
                  key={doc.id || `doc-${i}`}
                  doc={doc}
                  index={i}
                  onOpen={openDocument}
                />
              ))
            ) : (
              <div className="flex items-center gap-2 bg-gray-50 border
                              border-gray-200 rounded-xl p-3">
                <SvgIcon d={PATHS.docEmpty} color="#9CA3AF" size={20} />
                <span className="text-sm text-gray-500 font-medium">
                  No documents attached
                </span>
              </div>
            )}
          </Section>

          {/* ── Class Assignment ── */}
          <Section>
            <SectionHeader
              icon={<SvgIcon d={PATHS.school} color="#4F46E5" size={16} />}
              title="Assign Class Upon Approval"
            />

            {classes.length === 0 ? (
              <div className="flex items-start gap-2 bg-amber-50 rounded-xl p-3">
                <span className="text-amber-600 mt-0.5">⚠️</span>
                <p className="text-sm text-amber-700 font-medium">
                  No active classes found. Create a class before approving.
                </p>
              </div>
            ) : (
              <div data-class-picker>
                <ClassPicker
                  classes={classes}
                  selectedClassId={selectedClassId}
                  onSelect={(cls) => {
                    setSelectedClassId(String(cls.id));
                    setPickerOpen(false);
                    setError(null);
                  }}
                  open={pickerOpen}
                  onToggle={() => setPickerOpen((p) => !p)}
                  disabled={isBusy}
                />
              </div>
            )}
          </Section>

          {/* ── Rejection Reason ── */}
          <Section>
            <SectionHeader
              icon={<SvgIcon d={PATHS.chat} color="#DC2626" size={16} />}
              title="Rejection Reason"
              suffix={
                <span className="text-xs text-gray-400 font-normal">
                  (Optional)
                </span>
              }
            />
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Write a reason for rejection…"
              rows={3}
              disabled={isBusy}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl
                         px-4 py-3 text-sm text-gray-900 placeholder-gray-400
                         resize-none focus:outline-none focus:ring-2
                         focus:ring-red-400 disabled:opacity-50"
            />
          </Section>

          {/* ── Action Buttons ── */}
          <div className="flex gap-3 mt-1">
            <button
              onClick={handleReject}
              disabled={isBusy}
              className="flex-1 flex items-center justify-center gap-2
                         bg-red-600 hover:bg-red-700 disabled:bg-gray-300
                         text-white font-bold text-sm rounded-xl py-3.5
                         transition-colors focus:outline-none focus:ring-2
                         focus:ring-red-400 focus:ring-offset-2"
            >
              {rejecting ? (
                <Spinner size={20} color="#fff" />
              ) : (
                <>
                  <SvgIcon d={PATHS.closeCirc} color="#fff" size={18} />
                  Reject
                </>
              )}
            </button>

            <button
              onClick={handleApprove}
              disabled={isBusy || classes.length === 0}
              className="flex-1 flex items-center justify-center gap-2
                         bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300
                         text-white font-bold text-sm rounded-xl py-3.5
                         transition-colors focus:outline-none focus:ring-2
                         focus:ring-emerald-400 focus:ring-offset-2"
            >
              {approving ? (
                <Spinner size={20} color="#fff" />
              ) : (
                <>
                  <SvgIcon d={PATHS.checkCirc} color="#fff" size={18} />
                  Approve
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};