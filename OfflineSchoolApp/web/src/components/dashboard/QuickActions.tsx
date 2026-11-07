// web/src/components/dashboard/QuickActions.tsx
import { useNavigate }      from "react-router-dom";
import { useTranslation }    from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { QUICK_ACTIONS }    from "@/constants/dashboard.constants";
import { DASH_TINT }        from "@/config/dashboardTint";
import { cn }               from "@/utils/cn";

/**
 * The things an admin opens the console to do.
 *
 * This replaces two panels that overlapped almost completely: a grid of emoji
 * tiles, and a "Modules" list that reproduced the sidebar with a description
 * under each entry. The sidebar is the navigation — a second copy of it on the
 * landing page is not a feature, it is why the page needed scrolling.
 *
 * What is left is only the actions that *start* something. Each is a soft
 * tinted card in its own colour with a solid icon square of the same colour,
 * all at one weight. Create exam is highlighted, not filled: the same blue
 * tint with a blue border and a ringed icon, so the page still has an obvious
 * next step without one solid tile shouting over the grid.
 */
const HIGHLIGHT_CARD =
  "rounded-card border border-accent-blue-solid border-t-[3px] bg-accent-blue-soft shadow-card";

export default function QuickActions() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader title={t("dashboard.quickActions")} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {QUICK_ACTIONS.map(({ label, labelKey, icon: Icon, path, primary, accent }) => (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            className={cn(
              "group flex flex-col items-start gap-3 p-4 text-left text-ink",
              "transition duration-150 ease-[var(--ease-out-quiet)] hover:shadow-lift",
              // The highlighted action: the same blue tint, a blue border all round.
              primary ? HIGHLIGHT_CARD : DASH_TINT[accent].card,
            )}
          >
            <span
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-control",
                DASH_TINT[accent].box,
                primary && "ring-2 ring-accent-blue ring-offset-2 ring-offset-accent-blue-soft",
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
