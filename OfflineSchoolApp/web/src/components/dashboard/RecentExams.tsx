// web/src/components/dashboard/RecentExams.tsx
import { FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { type RecentExam } from "@/services/dashboard.service";

interface Props {
  exams:    RecentExam[];
  loading?: boolean;
  error?:   string;
}

export default function RecentExams({ exams, loading = false, error }: Props) {
  const navigate = useNavigate();

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-orange-500" aria-hidden="true" />
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Recent Exams
          </h3>
        </div>
        <button
          type="button"
          onClick={() => navigate("/exams")}
          className="text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium"
        >
          View all
        </button>
      </div>

      {/* Error state */}
      {error && (
        <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
      )}

      {/* Loading skeleton */}
      {loading && !error && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && exams.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
          No exams found.
        </p>
      )}

      {/* List */}
      {!loading && !error && exams.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {exams.map((exam) => (
            <li
              key={exam._id}
              onClick={() => navigate(`/exams/${exam._id}`)}
              className="flex items-center justify-between py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40 -mx-1 px-1 rounded-lg transition"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                  {exam.title}
                </p>
                {exam.subject && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
                    {exam.subject}
                  </p>
                )}
              </div>
              <StatusPill status={exam.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  ongoing:   "bg-green-100  text-green-700  dark:bg-green-900/30  dark:text-green-400",
  completed: "bg-gray-100   text-gray-600   dark:bg-gray-700      dark:text-gray-300",
  draft:     "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  scheduled: "bg-blue-100   text-blue-700   dark:bg-blue-900/30   dark:text-blue-400",
};

function StatusPill({ status }: { status?: string }) {
  const label = status ?? "unknown";
  const style = STATUS_STYLES[label.toLowerCase()] ?? STATUS_STYLES.draft;
  return (
    <span className={`shrink-0 ml-2 text-xs font-medium px-2 py-0.5 rounded-full capitalize ${style}`}>
      {label}
    </span>
  );
}