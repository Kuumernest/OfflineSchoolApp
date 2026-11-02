// web/src/components/dashboard/QuickActions.tsx
import { useNavigate }      from "react-router-dom";
import { useTranslation }    from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { QUICK_ACTIONS }    from "@/constants/dashboard.constants";
import { cn }               from "@/utils/cn";

/**
 * The things an admin opens the console to do.
 *
 * This replaces two panels that overlapped almost completely: a grid of emoji
 * tiles, and a "Modules" list that reproduced the sidebar with a description
 * under each entry. The sidebar is the navigation — a second copy of it on the
 * landing page is not a feature, it is why the page needed scrolling.
 *
 * What is left is only the actions that *start* something. They are white
 * cards with a blue icon box, all at one weight — except Create exam, the one
 * filled primary action, so the page has a single obvious next step.
 */
export default function QuickActions() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader title={t("dashboard.quickActions")} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {QUICK_ACTIONS.map(({ label, labelKey, icon: Icon, path, primary }) => (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            className={cn(
              "group flex flex-col items-start gap-3 rounded-card p-4 text-left",
              "transition duration-150 ease-[var(--ease-out-quiet)]",
              primary
                ? "bg-primary-600 text-white shadow-card hover:bg-primary-700"
                : "border border-line bg-surface text-ink shadow-card hover:border-line-strong hover:shadow-lift",
            )}
          >
            <span
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-control",
                primary ? "bg-white/15 text-white" : "bg-accent-blue-soft text-accent-blue",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="w-full text-sm font-semibold leading-snug">
              {t(labelKey, { defaultValue: label })}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
