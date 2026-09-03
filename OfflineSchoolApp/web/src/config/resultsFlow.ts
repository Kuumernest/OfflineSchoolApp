// web/src/config/resultsFlow.ts
/**
 * The one pipeline the console never showed anybody.
 *
 * ── The problem this describes ────────────────────────────────────────────
 *
 * Getting from "we sat an exam" to "here is the report card" takes five
 * actions across four screens, and until now nothing anywhere said so. Each
 * screen was correct on its own and silent about the one before and after it,
 * so a new user met the flow as a set of pages that each seemed to want
 * something, in an order they had to discover by failing.
 *
 * The gates are real and none of them announced itself:
 *
 *   · Calculate results does nothing until marks are entered.
 *   · A term average is built from the term's sequences, so BOTH of them have
 *     to be calculated first — a term computed against one is not a smaller
 *     answer, it is a wrong one.
 *   · Term and annual report cards only list pupils the term has been computed
 *     for. An empty pupil list on the print screen means step four was never
 *     run, which is not something an empty list says.
 *
 * ── And the rule that is NOT a gate ───────────────────────────────────────
 *
 * Publishing. It is the most official-sounding button on the exam screen, so
 * everybody assumes the pipeline is blocked on it. It is not: publishing makes
 * results visible to families in the portal, and the term computes perfectly
 * well without it. Saying so is half the value of this file, because the
 * alternative is a school that thinks it is stuck.
 *
 * ── Why it is a config and not markup ────────────────────────────────────
 *
 * PageHeader draws it, so a screen in the flow shows where it sits without the
 * page being edited, and a screen outside it shows nothing. One description of
 * the pipeline, in one place, that cannot disagree with itself.
 */

export interface FlowStep {
  key: string;
  labelKey: string;
  label: string;
  /** One line on what this step actually does. */
  hintKey: string;
  hint: string;
  /** Where the step is performed. */
  path: string;
}

export const RESULTS_FLOW: FlowStep[] = [
  {
    key: "exam",
    labelKey: "flow.exam", label: "Create the exam",
    hintKey: "flow.examHint",
    hint: "Name it, set its sequence, and choose the classes and subjects it covers.",
    path: "/exams",
  },
  {
    key: "marks",
    labelKey: "flow.marks", label: "Enter marks",
    hintKey: "flow.marksHint",
    hint: "Subject by subject, for every pupil in the class.",
    path: "/exams",
  },
  {
    key: "calculate",
    labelKey: "flow.calculate", label: "Calculate results",
    hintKey: "flow.calculateHint",
    hint: "Turns the marks into each pupil's average and position for this exam.",
    path: "/exams/results",
  },
  {
    key: "term",
    labelKey: "flow.term", label: "Compute the term",
    hintKey: "flow.termHint",
    hint: "Combines the term's two sequences by weight. Both must be calculated first.",
    path: "/exams/term-results",
  },
  {
    key: "print",
    labelKey: "flow.print", label: "Print report cards",
    hintKey: "flow.printHint",
    hint: "Sequence, term or annual cards for a whole class or one pupil.",
    path: "/reports/cards",
  },
];

/**
 * Which step a route is, or null for a screen outside the flow.
 *
 * The exam detail page is where marks are entered, so any /exams/<id> that is
 * not one of the flow's own literal routes resolves to step two.
 */
export function flowStepForPath(pathname: string): number | null {
  if (pathname === "/exams" || pathname === "/exams/create") return 0;
  if (pathname === "/exams/results") return 2;
  if (pathname === "/exams/term-results" || pathname === "/exams/annual-results") return 3;
  if (pathname === "/reports/cards") return 4;
  // /exams/<id> and anything under it — the marks screen.
  if (/^\/exams\/[^/]+/.test(pathname)) return 1;
  return null;
}
