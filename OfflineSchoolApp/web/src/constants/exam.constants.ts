// web/src/constants/exam.constants.ts
import type { ExamStatus, ExamType } from "@/types/exam.types";

// `labelKey` rather than a literal: these render on the Exams, Results and
// Report-cards pages, which are fully translated. The object key is the stored
// status value and must not change.
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

/** Keys are the stored exam-type values; only the label is localised. */
export const EXAM_TYPE_KEYS: Record<ExamType, string> = {
  first_test:            "examType.first_test",
  second_test:           "examType.second_test",
  mid_term:              "examType.mid_term",
  practical:             "examType.practical",
  final_exam:            "examType.final_exam",
  mock_exam:             "examType.mock_exam",
  promotion_exam:        "examType.promotion_exam",
  continuous_assessment: "examType.continuous_assessment",
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

export const EXAM_STATUS_OPTIONS = Object.entries(EXAM_STATUS_META).map(
  ([value, meta]) => ({ value, labelKey: meta.labelKey })
);

// `value` is the term as the backend stores it and must stay English;
// `label` is only the fallback when a translation key is missing.
export const TERM_OPTIONS = [
  { value: "Term 1",      label: "Term 1",     labelKey: "examTerms.term1"     },
  { value: "Term 2",      label: "Term 2",     labelKey: "examTerms.term2"     },
  { value: "Term 3",      label: "Term 3",     labelKey: "examTerms.term3"     },
  { value: "Semester 1",  label: "Semester 1", labelKey: "examTerms.semester1" },
  { value: "Semester 2",  label: "Semester 2", labelKey: "examTerms.semester2" },
];

const year = new Date().getFullYear();
export const ACADEMIC_YEAR_OPTIONS = [
  `${year - 1}/${year}`,
  `${year}/${year + 1}`,
  `${year + 1}/${year + 2}`,
].map((y) => ({ value: y, label: y }));