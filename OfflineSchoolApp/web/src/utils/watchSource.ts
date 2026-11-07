// web/src/utils/watchSource.ts
//
// Which exam a Students to watch flag rests on, so a teacher can check it:
// "Failed the last exam (8/20, pass mark 10) · 2nd Sequence, 10 Oct 2026".
// The server sends `exam` (and `fromExam` for a drop) on the mark-based flags
// — failed_exam, grade_drop, subjects_failed (earlyWarning.service).
//
// Imports nothing, so scripts/check-watch-source.mjs can run it as it is.

export interface ExamSource {
  examId: string;
  name:   string | null;
  date:   string | null;
}

export interface WatchSourceLine {
  /** The i18n key under watch.source. */
  key:   "named" | "dated" | "drop" | "dropDated";
  exam:  string;
  from?: string;
  /** Raw date, for the page's own formatter. */
  date?: string;
}

/**
 * The source line for a signal, or null when the signal does not rest on a
 * mark or the exam has no name to give (its row is gone).
 */
export function watchSource(signal: { exam?: ExamSource | null; fromExam?: ExamSource | null }): WatchSourceLine | null {
  const exam = signal.exam;
  if (!exam?.name) return null;
  const from = signal.fromExam?.name ?? null;
  const date = exam.date ?? null;
  if (from) {
    return date ? { key: "dropDated", exam: exam.name, from, date } : { key: "drop", exam: exam.name, from };
  }
  return date ? { key: "dated", exam: exam.name, date } : { key: "named", exam: exam.name };
}
