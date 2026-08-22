// web/src/components/dashboard/QuickActions.tsx
import { useNavigate }      from "react-router-dom";
import { useTranslation }    from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { QUICK_ACTIONS }    from "@/constants/dashboard.constants";

/**
 * The things an admin opens the console to do.
 *
 * This replaces two panels that overlapped almost completely: a grid of emoji
 * tiles, and a "Modules" list that reproduced the sidebar with a description
 * under each entry. The sidebar is the navigation — a second copy of it on the
 * landing page is not a feature, it is why the page needed scrolling.
 *
 * What is left is only the actions that *start* something. Each is a tile with
 * a recessed icon well that fills with accent on hover, so the grid reads as a
 * set of controls rather than a list of links.
 */
export default function QuickActions() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader title={t("dashboard.quickActions")} />

      <div className="grid grid-cols-2 gap-2">
        {QUICK_ACTIONS.map(({ label, labelKey, icon: Icon, path }) => (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            className="
              group flex flex-col items-start gap-2 rounded-control
              border border-line bg-gradient-to-b from-surface to-[#fcfcfe]
              p-2.5 text-left
              transition duration-150 ease-[var(--ease-out-quiet)]
              hover:-translate-y-px hover:border-line-strong hover:shadow-card
            "
          >
            <span
              className="
                flex h-7 w-7 items-center justify-center rounded-control
                bg-canvas text-ink-muted ring-1 ring-inset ring-line
                transition-colors duration-150
                group-hover:bg-primary-600 group-hover:text-white group-hover:ring-primary-600
              "
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="w-full truncate text-xs font-medium leading-tight text-ink-body transition-colors group-hover:text-ink">
              {t(labelKey, { defaultValue: label })}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
