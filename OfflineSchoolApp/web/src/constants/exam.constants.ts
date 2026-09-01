// web/src/constants/exam.constants.ts
import type { ExamStatus, ExamType, SequenceNumber, TermNumber } from "@/types/exam.types";

// ── Exam Status ─────────────────────────────────────────────────────────────

export const EXAM_STATUS_META: Record<
  ExamStatus,
  { labelKey: string; color: string; bg: string; dot: string }
> = {
  draft:     { labelKey: "examStatus.draft",     color: "text-gray-600",   bg: "bg-gray-100",   dot: "bg-gray-400"   },
  scheduled: { labelKey: "examStatus.scheduled", color: "text-indigo-600", bg: "bg-indigo-50",  dot: "bg-indigo-500" },
  ongoing:   { labelKey: "examStatus.ongoing",   color: "text-amber-600",  bg: "bg-amber-50",   dot: "bg-amber-500"  },
  completed: { labelKey: "examStatus.completed", color: "text-green-600",  bg: "bg-green-50",   dot: "bg-green-500"  },
  published: { labelKey: "examStatus.published", color: "text-purple-600", bg: "bg-purple-50",  dot: "bg-purple-500" },
  archived:  { labelKey: "examStatus.archived",  color: "text-gray-400",   bg: "bg-gray-50",    dot: "bg-gray-300"   },
};

// ── Exam Types (simplified) ─────────────────────────────────────────────────

export const EXAM_TYPE_KEYS: Record<ExamType, string> = {
  test:            "examType.test",
  practical:       "examType.practical",
  promotion_exam:  "examType.promotion_exam",
};

export const EXAM_TYPE_OPTIONS = Object.entries(EXAM_TYPE_KEYS).map(
  ([value, labelKey]) => ({ value, labelKey })
);

/** Localised exam-type label, falling back to the raw stored value. */
export const examTypeLabel = (
  t: (key: string) => string,
  type: string | undefined | null,
): string =>
  type && EXAM_TYPE_KEYS[type as ExamType]
    ? t(EXAM_TYPE_KEYS[type as ExamType])
    : (type ?? "");

// ── Sequences ───────────────────────────────────────────────────────────────

export const SEQUENCE_MAP: Record<
  SequenceNumber,
  { term: TermNumber; name: string; labelKey: string }
> = {
  1: { term: 1, name: "Sequence 1", labelKey: "examSequence.seq1" },
  2: { term: 1, name: "Sequence 2", labelKey: "examSequence.seq2" },
  3: { term: 2, name: "Sequence 3", labelKey: "examSequence.seq3" },
  4: { term: 2, name: "Sequence 4", labelKey: "examSequence.seq4" },
  5: { term: 3, name: "Sequence 5", labelKey: "examSequence.seq5" },
  6: { term: 3, name: "Sequence 6", labelKey: "examSequence.seq6" },
};

/** Get sequences for a given term */
export const getSequencesForTerm = (term: TermNumber): SequenceNumber[] =>
  (Object.entries(SEQUENCE_MAP) as [string, { term: TermNumber }][] )
    .filter(([, v]) => v.term === term)
    .map(([k]) => Number(k) as SequenceNumber);

// ── Terms ───────────────────────────────────────────────────────────────────

export const TERM_OPTIONS = [
  { value: "1", labelKey: "examTerms.term1" },
  { value: "2", labelKey: "examTerms.term2" },
  { value: "3", labelKey: "examTerms.term3" },
];

// ── Status Options ──────────────────────────────────────────────────────────

export const EXAM_STATUS_OPTIONS = Object.entries(EXAM_STATUS_META).map(
  ([value, meta]) => ({ value, labelKey: meta.labelKey })
);

// ── Academic Years ──────────────────────────────────────────────────────────

const year = new Date().getFullYear();
export const ACADEMIC_YEAR_OPTIONS = [
  `${year - 1}/${year}`,
  `${year}/${year + 1}`,
  `${year + 1}/${year + 2}`,
].map((y) => ({ value: y, label: y }));
