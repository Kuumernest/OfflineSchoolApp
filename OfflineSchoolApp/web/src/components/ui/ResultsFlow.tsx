// web/src/components/ui/ResultsFlow.tsx
import { Link }            from "react-router-dom";
import { useTranslation }  from "react-i18next";
import { Check }           from "lucide-react";
import { cn }              from "@/utils/cn";
import { RESULTS_FLOW }    from "@/config/resultsFlow";

/**
 * Where this screen sits in the exam → results → report card pipeline.
 *
 * Five steps across four screens, each of which used to be silent about the
 * one before and after it. A new user met them as a set of pages that each
 * seemed to want something, in an order they had to discover by failing —
 * usually at the print screen, which lists no pupils until the term has been
 * computed and does not say that is why.
 *
 * Drawn by PageHeader for the routes in the flow, so no page had to be edited
 * and no page can disagree with another about the order.
 *
 * ── What the marks mean ───────────────────────────────────────────────────
 *
 * A tick is "behind you in the order", NOT "done" — this component reads no
 * data. Claiming a step is complete when nothing has checked would be worse
 * than saying nothing: it is the failure mode of every progress bar that lies.
 * So the numbering shows the path, the current step is named, and the state of
 * the work stays where the work is.
 */
export function ResultsFlow({ current }: { current: number }) {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t("flow.title", { defaultValue: "Results workflow" })}
      className="mt-5 rounded-card border border-line bg-surface-muted p-1.5"
    >
      <ol className="flex flex-wrap items-stretch gap-1">
        {RESULTS_FLOW.map((step, i) => {
          const done   = i < current;
          const active = i === current;

          return (
            <li key={step.key} className="min-w-[168px] flex-1">
              <Link
                to={step.path}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex h-full items-start gap-2.5 rounded-[10px] px-3 py-2.5",
                  "transition-colors",
                  active
                    ? "bg-surface shadow-card ring-1 ring-primary-200"
                    : "hover:bg-surface"
                )}
              >
                <span
                  className={cn(
                    "mt-px flex h-5 w-5 shrink-0 items-center justify-center",
                    "rounded-full text-[11px] font-bold",
                    active
                      ? "bg-primary-600 text-white"
                      : done
                        ? "bg-primary-100 text-primary-700"
                        : "bg-gray-200 text-ink-muted"
                  )}
                >
                  {done ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
                </span>

                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-xs font-semibold leading-tight",
                      active ? "text-ink" : "text-ink-body"
                    )}
                  >
                    {t(step.labelKey, { defaultValue: step.label })}
                  </span>
                  {/* The hint is the point. A row of five words is a diagram;
                      a row of five sentences is an explanation, and this flow
                      needed the second one. Shown on the step you are on and
                      on wide screens, where there is room for all five. */}
                  <span
                    className={cn(
                      "mt-1 text-[11px] leading-snug text-ink-muted",
                      active ? "block" : "hidden xl:block"
                    )}
                  >
                    {t(step.hintKey, { defaultValue: step.hint })}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      {/* The rule that is not a rule. Publishing is the most official-sounding
          button in the flow, so everybody assumes it blocks the next step. It
          does not, and a school that believes it does thinks it is stuck. */}
      <p className="px-3 pb-1.5 pt-2 text-[11px] leading-snug text-ink-muted">
        {t("flow.publishNote", {
          defaultValue:
            "Publishing results is optional — it shows them to families in the portal. The term can be computed and cards printed without it.",
        })}
      </p>
    </nav>
  );
}
