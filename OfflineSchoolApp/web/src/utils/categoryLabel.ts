// web/src/utils/categoryLabel.ts
//
// An expense category's name in the reader's language.
//
// Categories carry `label` (English) and an optional `labelFr`, the bilingual
// convention fee items and salary components follow. The default categories a
// school starts with are seeded with both, so a French-speaking bursar reads
// "Entretien", not "Maintenance". A category somebody made with no French name
// falls back to its label.

export interface LabelledCategory {
  label:    string;
  labelFr?: string | null;
}

export const categoryLabel = (
  category: LabelledCategory | null | undefined,
  language: string | null | undefined,
): string | undefined => {
  if (!category) return undefined;
  const french = String(language ?? "").toLowerCase().startsWith("fr");
  const fr = category.labelFr?.trim();
  return french && fr ? fr : category.label;
};
