// web/src/components/dashboard/AlertsPanel.tsx
import { useNavigate }           from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AlertSeverity, DashAlert } from "@/services/dashboardAlerts";

// deriveAlerts and the DashAlert/AlertSeverity types now live in
// services/dashboardAlerts.ts. This file exports only components, which is what
// lets React Fast Refresh keep the panel mounted across an edit — and it means a
// service no longer has to import a component to reach a pure function.

// ─────────────────────────────────────────────────────────
// STYLE MAP
// ─────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<
  AlertSeverity,
  {
    wrap:    string;
    icon:    string;
    text:    string;
    chevron: string;
    Icon:    typeof AlertCircle;
  }
> = {
  danger: {
    wrap:    "bg-danger-soft border-danger-line hover:brightness-[0.98]",
    icon:    "text-danger",
    text:    "text-danger",
    chevron: "text-danger/50",
    Icon:    AlertCircle,
  },
  warning: {
    wrap:    "bg-warning-soft border-warning-line hover:brightness-[0.98]",
    icon:    "text-warning",
    text:    "text-warning",
    chevron: "text-warning/50",
    Icon:    AlertTriangle,
  },
  info: {
    wrap:    "bg-info-soft border-info-line hover:brightness-[0.98]",
    icon:    "text-info",
    text:    "text-info",
    chevron: "text-info/50",
    Icon:    Info,
  },
};

// ─────────────────────────────────────────────────────────
// SINGLE ALERT ROW
// ─────────────────────────────────────────────────────────

function AlertRow({
  alert,
  onClick,
}: {
  alert:   DashAlert;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const s = SEVERITY_STYLES[alert.type];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex w-full items-center gap-3
        rounded-card border px-4 py-3 text-left
        transition-[filter]
        ${s.wrap}
      `}
    >
      <s.Icon
        className={`h-4 w-4 shrink-0 ${s.icon}`}
        aria-hidden="true"
      />
      <span className={`flex-1 text-sm ${s.text}`}>
        {t(alert.messageKey, alert.params)}
      </span>
      <ChevronRight
        className={`h-4 w-4 shrink-0 ${s.chevron}`}
        aria-hidden="true"
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// PUBLIC COMPONENT
// Returns null when there are no alerts so the parent grid
// does not leave an empty white card on screen.
// ─────────────────────────────────────────────────────────

export default function AlertsPanel({ alerts }: { alerts: DashAlert[] }) {
  const navigate = useNavigate();

  if (alerts.length === 0) return null;

  return (
    /*
      No card wrapper. These already carry a tinted, bordered surface each —
      nesting them inside a white panel with an "Alerts (3)" heading framed a
      warning inside a box inside a box, and the count restated what three
      visible rows already said.
    */
    <div className="space-y-2">
      {alerts.map((alert) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          onClick={() => navigate(alert.route)}
        />
      ))}
    </div>
  );
}