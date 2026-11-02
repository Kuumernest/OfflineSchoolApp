// web/src/components/dashboard/QuickActions.tsx
import { useNavigate }      from "react-router-dom";
import { useTranslation }    from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { QUICK_ACTIONS }    from "@/constants/dashboard.constants";
import { TILE_TONE }        from "@/config/sections";
import { cn }               from "@/utils/cn";

/**
 * The things an admin opens the console to do.
 *
 * This replaces two panels that overlapped almost completely: a grid of emoji
 * tiles, and a "Modules" list that reproduced the sidebar with a description
 * under each entry. The sidebar is the navigation — a second copy of it on the
 * landing page is not a feature, it is why the page needed scrolling.
 *
 * What is left is only the actions that *start* something. Each is a solid
 * tile in the colour of what it acts on — Add student is teal like every other
 * pupil figure, Create exam burnt orange like the exam tiles — so the colour a
 * person learned on the stat row finds the button too (config/sections.ts).
 */
export default function QuickActions() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader title={t("dashboard.quickActions")} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {QUICK_ACTIONS.map(({ label, labelKey, icon: Icon, path, tone }) => (
          <button
            key={path}
            type="button"
            onClick={() => navigate(path)}
            className={cn(
              "group flex flex-col items-start gap-3 rounded-tile p-4 text-left shadow-tile",
              "transition duration-150 ease-[var(--ease-out-quiet)]",
              "hover:-translate-y-0.5 hover:shadow-tile-lift",
              TILE_TONE[tone].fill,
            )}
          >
            <span
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-control",
                TILE_TONE[tone].well,
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
