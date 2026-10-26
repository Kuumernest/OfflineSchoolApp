import type { TFunction } from "i18next";
import type { CoefficientCascade } from "@/services/class.service";

/**
 * The notice to show after a coefficient edit reached the exams, or null when
 * it reached none.
 *
 * Shared by every screen that can edit a subject — the subject edit page and
 * the subject modal on the classes page — so they cannot drift on what a head
 * is told when averages are about to move.
 */
export function coefficientCascadeNotice(
  t: TFunction,
  cascade: CoefficientCascade | null,
): { kind: "warning" | "success"; title: string; message: string } | null {
  if (!cascade || cascade.examSubjectsUpdated <= 0) return null;
  return {
    kind:  cascade.reprocessRequired ? "warning" : "success",
    title: t("subjectsEdit.coeffAppliedTitle"),
    message: [
      t("subjectsEdit.coeffApplied", {
        count: cascade.examSubjectsUpdated,
        exams: cascade.examsAffected,
      }),
      cascade.skippedOverridden > 0
        ? t("subjectsEdit.coeffSkippedOwn", { count: cascade.skippedOverridden })
        : null,
      cascade.skippedFinalised > 0
        ? t("subjectsEdit.coeffSkippedFinal", { count: cascade.skippedFinalised })
        : null,
      cascade.reprocessRequired ? t("subjectsEdit.coeffReprocess") : null,
    ].filter(Boolean).join(" "),
  };
}
