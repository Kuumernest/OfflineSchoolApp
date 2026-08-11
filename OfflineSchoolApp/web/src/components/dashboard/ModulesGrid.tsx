// web/src/components/dashboard/ModulesGrid.tsx
import { useState }        from "react";
import { useNavigate }     from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
}                          from "lucide-react";
import { ALL_MODULES }     from "@/constants/dashboard.constants";

// How many modules to show before the "Show More" button appears
const PREVIEW_COUNT = 7;

export default function ModulesGrid() {
  const navigate               = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const visible     = expanded ? ALL_MODULES : ALL_MODULES.slice(0, PREVIEW_COUNT);
  const hiddenCount = ALL_MODULES.length - PREVIEW_COUNT;

  return (
    <div
      className="
        rounded-xl border border-gray-200 dark:border-gray-700
        bg-white dark:bg-gray-800
        p-4 shadow-sm
      "
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <LayoutGrid
          className="h-4 w-4 text-indigo-600"
          aria-hidden="true"
        />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Modules
        </h3>
      </div>

      {/* Module rows */}
      <div className="space-y-1">
        {visible.map((mod) => {
          const Icon = mod.icon;

          return (
            <button
              key={mod.id}
              type="button"
              onClick={() => navigate(mod.href)}
              className="
                w-full flex items-center gap-3
                rounded-lg px-3 py-2.5 text-left
                hover:bg-gray-50 dark:hover:bg-gray-700/50
                transition-colors
              "
            >
              {/* Icon bubble */}
              <span
                className={`
                  h-9 w-9 rounded-lg shrink-0
                  flex items-center justify-center
                  ${mod.bg}
                `}
              >
                <Icon
                  className={`h-4 w-4 ${mod.color}`}
                  aria-hidden="true"
                />
              </span>

              {/* Title + description */}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-white">
                  {mod.title}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">
                  {mod.description}
                </span>
              </span>

              {/* Right chevron */}
              <ChevronDown
                className="h-4 w-4 text-gray-400 -rotate-90 shrink-0"
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      {/* Show more / less — only rendered when list exceeds PREVIEW_COUNT */}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="
            mt-2 w-full flex items-center justify-center gap-1
            py-2 rounded-lg text-sm font-semibold
            text-indigo-600 dark:text-indigo-400
            hover:bg-indigo-50 dark:hover:bg-indigo-900/20
            transition-colors
          "
        >
          {expanded ? (
            <>
              Show Less
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            </>
          ) : (
            <>
              Show {hiddenCount} More
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </>
          )}
        </button>
      )}
    </div>
  );
}