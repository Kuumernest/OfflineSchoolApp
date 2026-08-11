// web/src/components/dashboard/QuickActions.tsx
import { useNavigate } from "react-router-dom";

// ─────────────────────────────────────────────────────────
// ACTION CONFIG
// Add / remove entries here to change the grid
// ─────────────────────────────────────────────────────────
const ACTIONS = [
  { label: "Add Student",     emoji: "👨‍🎓", path: "/students"      },
  { label: "Add Teacher",     emoji: "👨‍🏫", path: "/teachers"      },
  { label: "Create Exam",     emoji: "📝",  path: "/exams"         },
  { label: "Attendance",      emoji: "✅",  path: "/attendance"    },
  { label: "Announcement",    emoji: "📢",  path: "/announcements" },
  { label: "View Reports",    emoji: "📊",  path: "/reports"       },
] as const;

// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────
export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200
                  dark:border-gray-700 shadow-sm p-6 flex flex-col"
    >
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-4">
        Quick Actions
      </h3>

      <div className="grid grid-cols-3 gap-3 flex-1">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => navigate(action.path)}
            className="
              flex flex-col items-center justify-center gap-2
              p-4 rounded-xl text-center
              border border-gray-100 dark:border-gray-700
              hover:border-primary-300 dark:hover:border-primary-700
              hover:bg-primary-50 dark:hover:bg-primary-900/20
              active:scale-95
              transition-all duration-150 group
            "
          >
            <span className="text-2xl leading-none select-none">
              {action.emoji}
            </span>
            <span
              className="
                text-xs font-medium leading-tight
                text-gray-600 dark:text-gray-400
                group-hover:text-primary-700 dark:group-hover:text-primary-400
              "
            >
              {action.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}