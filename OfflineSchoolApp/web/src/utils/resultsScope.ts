// web/src/utils/resultsScope.ts
//
// Which pupils the exam analytics page (/exams/results) is about.
//
// The page opens on every class the exam was sat in, the same pupils Term
// Results counts. It used to open on the first class, so an exam sat by Form 1,
// Form 2, Lower and Upper Sixth showed 10 pupils' figures under a title naming
// all four classes. One class is now only ever a choice the user made, and the
// page says so.
//
// Imports nothing, so scripts/check-results-scope.mjs can run it as it is.

export interface ClassOption {
  classId:   string;
  className: string | null;
}

export interface ResultsScope {
  /** The class to send to /stats and /rankings; undefined is every class. */
  classId:   string | undefined;
  /** The chosen class's name for "Showing … only"; null with every class. */
  className: string | null;
}

/**
 * The scope for a chosen class id ("" is All classes, the default).
 *
 * A class the exam has no results in — a stale choice carried over, or the
 * classes not loaded yet — is every class, so the figures and the label can
 * never name different pupils.
 */
export function resultsScope(chosen: string, classes: ClassOption[]): ResultsScope {
  if (!chosen) return { classId: undefined, className: null };
  const match = classes.find((c) => c.classId === chosen);
  if (!match) return { classId: undefined, className: null };
  return { classId: match.classId, className: match.className || match.classId };
}
