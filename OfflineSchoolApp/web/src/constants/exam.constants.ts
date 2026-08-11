// web/src/constants/exam.constants.ts
import type { ExamStatus, ExamType } from "@/types/exam.types";

export const EXAM_STATUS_META: Record<
  ExamStatus,
  { label: string; color: string; bg: string; dot: string }
> = {
  draft:     { label: "Draft",     color: "text-gray-600",   bg: "bg-gray-100",   dot: "bg-gray-400"   },
  scheduled: { label: "Scheduled", color: "text-indigo-600", bg: "bg-indigo-50",  dot: "bg-indigo-500" },
  ongoing:   { label: "Ongoing",   color: "text-amber-600",  bg: "bg-amber-50",   dot: "bg-amber-500"  },
  completed: { label: "Completed", color: "text-green-600",  bg: "bg-green-50",   dot: "bg-green-500"  },
  published: { label: "Published", color: "text-purple-600", bg: "bg-purple-50",  dot: "bg-purple-500" },
  archived:  { label: "Archived",  color: "text-gray-400",   bg: "bg-gray-50",    dot: "bg-gray-300"   },
};

export const EXAM_TYPE_LABELS: Record<ExamType, string> = {
  first_test:            "First Test",
  second_test:           "Second Test",
  mid_term:              "Mid-Term",
  practical:             "Practical",
  final_exam:            "Final Exam",
  mock_exam:             "Mock Exam",
  promotion_exam:        "Promotion Exam",
  continuous_assessment: "Continuous Assessment",
};

export const EXAM_TYPE_OPTIONS = Object.entries(EXAM_TYPE_LABELS).map(
  ([value, label]) => ({ value, label })
);

export const EXAM_STATUS_OPTIONS = Object.entries(EXAM_STATUS_META).map(
  ([value, meta]) => ({ value, label: meta.label })
);

export const TERM_OPTIONS = [
  { value: "Term 1",      label: "Term 1"      },
  { value: "Term 2",      label: "Term 2"      },
  { value: "Term 3",      label: "Term 3"      },
  { value: "Semester 1",  label: "Semester 1"  },
  { value: "Semester 2",  label: "Semester 2"  },
];

const year = new Date().getFullYear();
export const ACADEMIC_YEAR_OPTIONS = [
  `${year - 1}/${year}`,
  `${year}/${year + 1}`,
  `${year + 1}/${year + 2}`,
].map((y) => ({ value: y, label: y }));