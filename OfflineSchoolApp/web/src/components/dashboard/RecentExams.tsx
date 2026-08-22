// web/src/components/dashboard/RecentExams.tsx
import { useNavigate }        from "react-router-dom";
import { useTranslation }      from "react-i18next";
import { ArrowRight }         from "lucide-react";
import { Card, CardHeader }   from "@/components/ui/Card";
import { Badge }              from "@/components/ui/Badge";
import { type RecentExam }    from "@/services/dashboard.service";

interface Props {
  exams:    RecentExam[];
  loading?: boolean;
  error?:   string;
}

export default function RecentExams({ exams, loading = false, error }: Props) {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader
        title={t("dashboard.recentExams")}
        action={
          <button
            type="button"
            onClick={() => navigate("/exams")}
            className="group inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            {t("common.viewAll")}
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      {loading && !error && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-control bg-canvas" />
          ))}
        </div>
      )}

      {!loading && !error && exams.length === 0 && (
        <p className="py-6 text-center text-sm text-ink-faint">
          {t("dashboard.noExams")}
        </p>
      )}

      {!loading && !error && exams.length > 0 && (
        // Negative margin so a row's hover fill reaches the card edge instead
        // of stopping short of the padding and looking clipped.
        <ul className="-mx-2">
          {exams.map((exam) => (
            <li key={exam._id}>
              <button
                type="button"
                onClick={() => navigate(`/exams/${exam._id}`)}
                className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left transition-colors hover:bg-canvas"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {exam.title}
                  </span>
                  {exam.subject && (
                    <span className="block truncate text-xs text-ink-faint">
                      {exam.subject}
                    </span>
                  )}
                </span>
                <StatusPill status={exam.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────
//
// Mapped onto the shared Badge variants rather than four bespoke colour pairs,
// so an exam's status reads the same here as it does on the exams table.

const STATUS_VARIANT: Record<
  string,
  "success" | "default" | "warning" | "info"
> = {
  ongoing:   "success",
  completed: "default",
  draft:     "warning",
  scheduled: "info",
};

function StatusPill({ status }: { status?: string }) {
  const label = status ?? "unknown";
  return (
    <Badge
      variant={STATUS_VARIANT[label.toLowerCase()] ?? "default"}
      className="shrink-0 capitalize"
    >
      {label}
    </Badge>
  );
}
