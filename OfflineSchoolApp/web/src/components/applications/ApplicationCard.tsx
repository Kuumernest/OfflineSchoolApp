// web/src/components/applications/ApplicationCard.tsx

import React            from "react";
import { isStale }      from "../../hooks/useApplications";
import { formatDate }   from "../../utils/formatDate";
import type { NormalisedApplication } from "../../types/applications";
import { useTranslation } from "react-i18next";

// ── Icons (inline SVGs to avoid external dependency) ─────────────────────

const Icon: React.FC<{
  d:     string;
  color: string;
  size?: number;
}> = ({ d, color, size = 14 }) => (
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

const ICONS = {
  school:   "M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20",
  people:   "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2M9 7a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
  phone:    "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z",
  doc:      "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  eye:      "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z",
  person:   "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4-4v2M12 7a4 4 0 100-8 4 4 0 000 8z",
} as const;

// ── Meta item ────────────────────────────────────────────────────────────

const MetaItem: React.FC<{
  icon:     React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, children }) => (
  <div className="flex items-center gap-1.5 min-w-0">
    {icon}
    <span className="text-[13px] font-medium text-gray-700 truncate">
      {children}
    </span>
  </div>
);

// ── Card ─────────────────────────────────────────────────────────────────

interface ApplicationCardProps {
  application: NormalisedApplication;
  onReview:    (application: NormalisedApplication) => void;
}

export const ApplicationCard: React.FC<ApplicationCardProps> = ({
  application,
  onReview,
}) => {
  const { t } = useTranslation();
  const stale    = isStale(application.created_at);
  const docCount = application.documents?.length ?? 0;

  return (
    <div
      className={[
        "bg-white rounded-2xl border p-4 transition-shadow hover:shadow-md",
        stale ? "border-red-200 border-[1.5px]" : "border-gray-200",
      ].join(" ")}
    >
      {/* ── Top row ── */}
      <div className="flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: stale ? "#FEE2E2" : "#FEF3C7" }}
        >
          <Icon
            d={ICONS.person}
            color={stale ? "#DC2626" : "#D97706"}
            size={22}
          />
        </div>

        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-900 truncate text-[15px]">
            {application.name}
          </p>
          <p className="text-xs text-gray-400 truncate mt-0.5">
            {application.email || "No email provided"}
          </p>
        </div>

        <span
          className={[
            "text-[10px] font-bold uppercase px-2 py-1 rounded-lg flex-shrink-0",
            stale
              ? "bg-red-100 text-red-700"
              : "bg-amber-100 text-amber-700",
          ].join(" ")}
        >
          {stale ? "Stale" : "Pending"}
        </span>
      </div>

      {/* ── Meta grid ── */}
      <div className="mt-3 grid grid-cols-2 gap-y-2 gap-x-4">
        <MetaItem icon={<Icon d={ICONS.school}   color="#4F46E5" />}>
          {application.className || "No class selected"}
        </MetaItem>

        <MetaItem icon={<Icon d={ICONS.people}   color="#6B7280" />}>
          {application.guardianName || "No guardian"}
        </MetaItem>

        <MetaItem icon={<Icon d={ICONS.calendar} color="#6B7280" />}>
          {formatDate(application.created_at)}
        </MetaItem>

        {application.phone && (
          <MetaItem icon={<Icon d={ICONS.phone} color="#059669" />}>
            {application.phone}
          </MetaItem>
        )}

        <MetaItem icon={<Icon d={ICONS.doc} color="#059669" />}>
          {docCount} {docCount === 1 ? "document" : "documents"}
        </MetaItem>
      </div>

      {/* ── Review button ── */}
      <button
        onClick={() => onReview(application)}
        className="mt-4 w-full bg-amber-600 hover:bg-amber-700 active:bg-amber-800
                   text-white font-bold text-sm rounded-xl py-3 flex items-center
                   justify-center gap-2 transition-colors focus:outline-none
                   focus:ring-2 focus:ring-amber-400 focus:ring-offset-2"
      >
        <Icon d={ICONS.eye} color="#fff" size={18} />
        {t("applications.reviewApplication")}
      </button>
    </div>
  );
};