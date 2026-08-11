// web/src/components/dashboard/RecentAnnouncements.tsx
import { useNavigate }             from "react-router-dom";
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
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading announcements">
      {[1, 2, 3].map((i) => (
        <div key={i} className="p-3 rounded-lg space-y-2">
          <div className="h-4 w-3/4 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
          <div className="h-3 w-full  rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
          <div className="h-3 w-1/3  rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
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
  const navigate = useNavigate();

  const body = (() => {
    if (loading) return <Skeleton />;

    if (error) {
      return (
        <div role="alert" className="text-center py-8">
          <Megaphone className="w-10 h-10 text-red-300 mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        </div>
      );
    }

    if (announcements.length === 0) {
      return (
        <div className="text-center py-8">
          <Megaphone className="w-10 h-10 text-gray-300 mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-gray-400 dark:text-gray-500">No announcements</p>
        </div>
      );
    }

    return (
      <ul className="space-y-3">
        {announcements.map((a) => (
          <li key={a._id}>
            <button
              type="button"
              onClick={() => navigate("/announcements")}
              className="
                w-full text-left p-3 rounded-lg
                hover:bg-gray-50 dark:hover:bg-gray-700/50
                cursor-pointer transition-colors
              "
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 line-clamp-1">
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
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 line-clamp-2">
                  {(a as RecentAnnouncement & { description?: string }).description}
                </p>
              )}

              {a.createdAt && (
                <p className="text-xs text-gray-300 dark:text-gray-600 mt-1.5">
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
        title="Announcements"
        subtitle="Recent school notices"
        action={
          <button
            type="button"
            onClick={() => navigate("/announcements")}
            className="
              text-sm text-primary-600 hover:text-primary-700
              dark:text-primary-400 dark:hover:text-primary-300
              flex items-center gap-1 font-medium
            "
          >
            View all
            <ArrowRight className="w-3 h-3" aria-hidden="true" />
          </button>
        }
      />
      {body}
    </Card>
  );
}