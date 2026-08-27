// web/src/components/dashboard/RecentAnnouncements.tsx
import { useNavigate }             from "react-router-dom";
import { useTranslation }           from "react-i18next";
import { Megaphone, ArrowRight }   from "lucide-react";
import { Card, CardHeader }        from "@/components/ui/Card";
import { Badge }                   from "@/components/ui/Badge";
import { type RecentAnnouncement } from "@/services/dashboard.service";
import { formatDistanceToNow }     from "date-fns";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

type BadgeVariant = "danger" | "warning" | "info" | "default";

const priorityVariant = (p: string | undefined): BadgeVariant => {
  switch (p) {
    case "urgent": return "danger";
    case "high":   return "warning";
    case "normal": return "info";
    default:       return "default";
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON
// ─────────────────────────────────────────────────────────────────────────────

function Skeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" aria-busy="true" aria-label={t("dashboard.loadingAnnouncements")}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="p-3 rounded-lg space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-canvas" />
          <div className="h-3 w-full animate-pulse rounded bg-canvas" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-canvas" />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  announcements: RecentAnnouncement[];
  loading?:      boolean;
  error?:        string;
}

export default function RecentAnnouncements({
  announcements,
  loading = false,
  error,
}: Props) {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  const body = (() => {
    if (loading) return <Skeleton />;

    if (error) {
      return (
        <div role="alert" className="text-center py-8">
          <Megaphone className="mx-auto mb-2 h-6 w-6 text-danger/50" aria-hidden="true" />
          <p className="text-sm text-danger">{error}</p>
        </div>
      );
    }

    if (announcements.length === 0) {
      return (
        <div className="text-center py-8">
          <Megaphone className="mx-auto mb-2 h-6 w-6 text-ink-faint" aria-hidden="true" />
          <p className="text-sm text-ink-faint">{t("dashboard.noAnnouncements")}</p>
        </div>
      );
    }

    return (
      <ul className="-mx-2 space-y-0.5">
        {announcements.map((a) => (
          <li key={a._id}>
            <button
              type="button"
              onClick={() => navigate("/announcements")}
              className="w-full rounded-control px-2 py-2 text-left transition-colors hover:bg-canvas"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-1 text-[13px] font-medium text-ink">
                  {a.title}
                </p>

                {/* FIX #PRIORITY — priority is optional on RecentAnnouncement.
                    Only render the badge when a value is present; pass a
                    guaranteed string so Badge.label never receives undefined. */}
                {a.priority && (
                  <Badge
                    label={a.priority}
                    variant={priorityVariant(a.priority)}
                  />
                )}
              </div>

              {/* FIX #BODY — RecentAnnouncement does not have a `body` field.
                  Use `description` or `message` if present on the type,
                  otherwise omit this block entirely. Check the dashboard
                  service type and use the correct field name below. */}
              {("description" in a) && (
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
                  {(a as RecentAnnouncement & { description?: string }).description}
                </p>
              )}

              {a.createdAt && (
                <p className="mt-1 text-xs text-ink-faint">
                  {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <Card>
      <CardHeader
        title={t("dashboard.announcementsTitle")}
        subtitle={t("dashboard.announcementsSubtitle")}
        action={
          <button
            type="button"
            onClick={() => navigate("/announcements")}
            className="group inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            {t("common.viewAll")}
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        }
      />
      {body}
    </Card>
  );
}