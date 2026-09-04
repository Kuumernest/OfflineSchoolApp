// web/src/pages/exams/[id]/index.tsx
import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery }                          from "@tanstack/react-query";
import { useParams, useNavigate,
         useSearchParams, Link }             from "react-router-dom";
import { fetchClasses }                      from "@/services/class.service";
import { useAuthStore }                      from "@/store/auth.store";
import { useExamDetail, useSubmissions,
         useApproveSubmission,
         useRejectSubmission,
         useUpdateExamSubject }              from "@/hooks/useExamDetail";
import { useExamResults, useExamStats,
         useProcessResults,
         usePublishResults }                 from "@/hooks/useExamResults";
import { useUpdateExamStatus, useUpdateExam } from "@/hooks/useExams";
import type { ExamStatus,
              ExamSubject,
              ExamType,
              SequenceNumber,
              TermNumber }                  from "@/types/exam.types";
import * as ExamService                      from "@/services/exam.service";
import api                                   from "@/services/api";
import { getErrorMessage }                   from "@/lib/axios";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";
import {
  EXAM_STATUS_META,
  EXAM_TYPE_KEYS,
  SEQUENCE_MAP,
  getSequencesForTerm,
  TERM_OPTIONS,
  ACADEMIC_YEAR_OPTIONS,
  examTypeLabel,
}                                            from "@/constants/exam.constants";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

type Tab = "details" | "marks" | "results";

type ExamSubjectWithTotals = ExamSubject & {
  totalStudents?: number;
};

/** One class's worth of subjects, for the per-class sections in MarksTab. */
interface ClassGroup {
  classId:   string | null;
  className: string;
  items:     ExamSubjectWithTotals[];
}

/**
 * Group an exam's subjects by the class they belong to.
 *
 * ── Why the class name has to come from outside the subject ────────────────
 *
 * GET /exams/:examId/submissions returns raw ExamSubject documents, and the
 * type says what the server sends: classId, and no readable class field at all.
 * So grouping by id is straightforward and NAMING the group cannot be done from
 * the row — which is why `classNames` is passed in, resolved from
 * /admin/classes.
 *
 * exam.classNames is not usable for this. It is a single comma-joined string
 * paired positionally with exam.classIds and it defaults to null, so on a
 * multi-class exam it either names the wrong class or names none.
 *
 * First-seen order is kept, so the sections follow the order the server
 * returned the subjects in rather than being re-sorted underneath the user.
 */
const groupSubjectsByClass = (
  submissions: ExamSubjectWithTotals[],
  classNames:  Record<string, string>,
  unknownLabel: string,
): ClassGroup[] => {
  const groups: ClassGroup[] = [];
  const index = new Map<string, ClassGroup>();

  for (const sub of submissions) {
    const cid = sub.classId ? String(sub.classId) : null;
    const key = cid ?? "__no_class__";

    let group = index.get(key);
    if (!group) {
      group = {
        classId:   cid,
        className: (cid && classNames[cid]) || unknownLabel,
        items:     [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(sub);
  }

  return groups;
};

interface ScoreEntry {
  score:         string;
  isAbsent:      boolean;
  teacherRemark: string;
}

/**
 * A student row in the mark-entry sheet.
 *
 * The roster arrives from three different endpoint shapes, each naming things
 * slightly differently (`_id` vs `id`, `studentName` vs `name`), so every field
 * is optional and read defensively at the point of use.
 */
interface MarkEntryStudent {
  _id?:          string;
  id?:           string;
  name?:         string;
  studentName?:  string;
  admissionNo?:  string;
}

/** One saved score row as the scores endpoint returns it. */
interface RawScoreRow {
  studentId:      string;
  score?:         number | string | null;
  isAbsent?:      boolean;
  teacherRemark?: string | null;
}

// ─────────────────────────────────────────────────────────
// PAGE-SPECIFIC CONSTANTS
// ─────────────────────────────────────────────────────────

// `key` is the ?tab= URL value — it must not change. Only the label is
// localised, and module scope has no `t`, so it is stored as a key.
const TABS: { key: Tab; labelKey: string }[] = [
  { key: "details", labelKey: "exams.tabDetails" },
  { key: "marks",   labelKey: "exams.tabMarks"   },
  { key: "results", labelKey: "nav.results"      },
];

const NEXT_STATUSES: Record<string, ExamStatus[]> = {
  draft:     ["scheduled", "ongoing"  ],
  scheduled: ["ongoing",   "draft"    ],
  ongoing:   ["completed"             ],
  completed: ["published", "archived" ],
  published: ["archived"              ],
  archived:  ["draft"                 ],
};

const SUBMISSION_META: Record<string, {
  color: string; bg: string; labelKey: string; icon: string;
}> = {
  pending:   { color: "text-amber-600",  bg: "bg-amber-50",  labelKey: "examSubmission.notSubmitted",     icon: "⏳" },
  submitted: { color: "text-indigo-600", bg: "bg-indigo-50", labelKey: "examSubmission.awaitingApproval", icon: "📬" },
  approved:  { color: "text-green-600",  bg: "bg-green-50",  labelKey: "results.approved",                icon: "✅" },
  rejected:  { color: "text-red-600",    bg: "bg-red-50",    labelKey: "results.rejected",                icon: "❌" },
};

const EMPTY_SCORE: ScoreEntry = {
  score: "", isAbsent: false, teacherRemark: "",
};

// ─────────────────────────────────────────────────────────
// SMALL SHARED COMPONENTS
// ─────────────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: ExamStatus }) => {
  const { t } = useTranslation();
  const meta = EXAM_STATUS_META[status] ?? EXAM_STATUS_META.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5
      rounded-full text-xs font-bold ${meta.color} ${meta.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {t(meta.labelKey)}
    </span>
  );
};

const Spinner = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
  const s = { sm: "w-4 h-4", md: "w-6 h-6", lg: "w-10 h-10" }[size];
  return (
    <div className={`${s} border-4 border-primary-600
                    border-t-transparent rounded-full animate-spin`} />
  );
};

const EmptyState = ({
  icon, title, subtitle,
}: {
  icon: string; title: string; subtitle?: string;
}) => (
  <div className="flex flex-col items-center justify-center
                  py-16 text-center text-gray-400">
    <span className="text-5xl mb-3">{icon}</span>
    <p className="font-semibold text-gray-600">{title}</p>
    {subtitle && <p className="text-sm mt-1">{subtitle}</p>}
  </div>
);

// ─────────────────────────────────────────────────────────
// TAB 1 — DETAILS
// ─────────────────────────────────────────────────────────

const DetailsTab = ({
  exam,
  submissions,
  onStatusChange,
  changingStatus,
  onUpdateExam,
  updatingExam,
}: {
  exam:           NonNullable<ReturnType<typeof useExamDetail>["data"]>["exam"];
  submissions:    ExamSubjectWithTotals[];
  onStatusChange: (s: ExamStatus) => void;
  changingStatus: boolean;
  onUpdateExam:   (data: Record<string, unknown>) => void;
  updatingExam:   boolean;
}) => {
  const { t } = useTranslation();
  const nextStatuses = NEXT_STATUSES[exam.status] ?? [];
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name:          exam.name          ?? "",
    type:          exam.type          ?? "test",
    sequenceNumber: String(exam.sequenceNumber ?? ""),
    academicYear:  exam.academicYear  ?? "",
    term:          String(exam.term    ?? ""),
    startDate:     exam.startDate     ?? "",
    endDate:       exam.endDate       ?? "",
    totalMarks:    String(exam.totalMarks ?? 100),
    passMark:      String(exam.passMark   ?? 50),
    description:   exam.description   ?? "",
    instructions:  exam.instructions  ?? "",
  });
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const handleEditChange = (field: string, value: string) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    if (editErrors[field]) setEditErrors((prev) => ({ ...prev, [field]: "" }));
  };

  const handleEditSave = () => {
    const errors: Record<string, string> = {};
    if (!editForm.name.trim()) errors.name = t("examCreate.nameRequired") as string;
    if (!editForm.academicYear) errors.academicYear = t("examCreate.yearRequired") as string;
    if (!editForm.term) errors.term = t("examCreate.termRequired") as string;
    const tm = Number(editForm.totalMarks);
    const pm = Number(editForm.passMark);
    if (!tm || tm <= 0) errors.totalMarks = t("examCreate.totalMarksRequired") as string;
    if (!pm || pm <= 0) errors.passMark = t("examCreate.passMarkRequired") as string;
    if (pm > tm) errors.passMark = t("examCreate.passMarkExceeds") as string;

    if (Object.keys(errors).length) {
      setEditErrors(errors);
      return;
    }

    onUpdateExam({
      name:          editForm.name.trim(),
      type:          editForm.type,
      sequenceNumber: editForm.sequenceNumber ? Number(editForm.sequenceNumber) : null,
      academicYear:  editForm.academicYear,
      term:          Number(editForm.term),
      startDate:     editForm.startDate || null,
      endDate:       editForm.endDate   || null,
      totalMarks:    tm,
      passMark:      pm,
      description:   editForm.description   || null,
      instructions:  editForm.instructions  || null,
    });
    setEditOpen(false);
  };

  const subjectProgress = submissions.map((sub) => {
    const entered = sub.totalScoresEntered ?? 0;
    const total   = sub.totalStudents      ?? 0;
    const pct     = total > 0 ? Math.round((entered / total) * 100) : 0;
    const meta    = SUBMISSION_META[sub.submissionStatus] ?? SUBMISSION_META.pending;
    return { sub, entered, total, pct, meta };
  });

  return (
    <div className="space-y-5">

      {/* Status card */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{t("exams.statusTitle")}</h3>
          <StatusBadge status={exam.status} />
        </div>

        {nextStatuses.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-2 font-medium">
              {t("exams.moveNextStage")}
            </p>
            <div className="flex gap-2 flex-wrap">
              {nextStatuses.map((s) => (
                <button
                  key={s}
                  onClick={() => onStatusChange(s)}
                  disabled={changingStatus}
                  className="px-4 py-2 text-sm font-semibold rounded-xl
                             border-2 border-gray-200 text-gray-700
                             hover:border-primary-400 hover:text-primary-700
                             hover:bg-primary-50 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {changingStatus ? (
                    <span className="flex items-center gap-2">
                      <Spinner size="sm" /> {t("exams.updating")}
                    </span>
                  ) : (
                    `→ ${t(EXAM_STATUS_META[s].labelKey)}`
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Exam info */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{t("exams.information")}</h3>
          <button
            onClick={() => setEditOpen(true)}
            className="px-3 py-1.5 text-sm font-semibold rounded-xl
                       border-2 border-gray-200 text-gray-700
                       hover:border-primary-400 hover:text-primary-700
                       hover:bg-primary-50 transition-colors"
          >
            {t("common.edit")}
          </button>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {[
            { labelKey: "common.type",           value: examTypeLabel(t, exam.type) },
            { labelKey: "academic.schoolYear",   value: exam.academicYear  },
            { labelKey: "academic.term",         value: exam.term          },
            { labelKey: "academic.class_other",  value: exam.classNames || exam.className || t("common.all") },
            { labelKey: "common.startDate",      value: exam.startDate || "—" },
            { labelKey: "common.endDate",        value: exam.endDate   || "—" },
            { labelKey: "examCreate.totalMarks", value: String(exam.totalMarks) },
            { labelKey: "academic.passMark",     value: String(exam.passMark)   },
          ].map(({ labelKey, value }) => (
            <div key={labelKey} className="flex flex-col">
              <dt className="text-xs font-semibold text-gray-400
                             uppercase tracking-wide">
                {t(labelKey)}
              </dt>
              <dd className="font-semibold text-gray-900 mt-0.5">{value}</dd>
            </div>
          ))}
        </dl>

        {exam.description && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-400
                          uppercase tracking-wide mb-1">
              {t("common.description")}
            </p>
            <p className="text-sm text-gray-600 leading-relaxed">
              {exam.description}
            </p>
          </div>
        )}
      </div>

      {/* Edit Exam Modal */}
      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {t("exams.editExam")}
            </h3>
            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("examCreate.name")} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => handleEditChange("name", e.target.value)}
                  className={`w-full px-3 py-2 rounded-xl border text-sm
                    focus:outline-none focus:ring-2 focus:ring-primary-500
                    ${editErrors.name ? "border-red-400" : "border-gray-200"}`}
                />
                {editErrors.name && <p className="text-xs text-red-500 mt-1">{editErrors.name}</p>}
              </div>

              {/* Type */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("common.type")}
                </label>
                <select
                  value={editForm.type}
                  onChange={(e) => handleEditChange("type", e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                             focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {Object.keys(EXAM_TYPE_KEYS).map((key) => (
                    <option key={key} value={key}>{examTypeLabel(t, key as ExamType)}</option>
                  ))}
                </select>
              </div>

              {/* Academic Year & Term */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("academic.schoolYear")} <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={editForm.academicYear}
                    onChange={(e) => handleEditChange("academicYear", e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-sm
                      focus:outline-none focus:ring-2 focus:ring-primary-500
                      ${editErrors.academicYear ? "border-red-400" : "border-gray-200"}`}
                  >
                    <option value="">{t("examCreate.selectYear")}</option>
                    {ACADEMIC_YEAR_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {editErrors.academicYear && <p className="text-xs text-red-500 mt-1">{editErrors.academicYear}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("academic.term")} <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={editForm.term}
                    onChange={(e) => handleEditChange("term", e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-sm
                      focus:outline-none focus:ring-2 focus:ring-primary-500
                      ${editErrors.term ? "border-red-400" : "border-gray-200"}`}
                  >
                    <option value="">{t("examCreate.selectTerm")}</option>
                    {TERM_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                    ))}
                  </select>
                  {editErrors.term && <p className="text-xs text-red-500 mt-1">{editErrors.term}</p>}
                </div>
              </div>

              {/* Sequence */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("examCreate.sequence")}
                </label>
                <select
                  value={editForm.sequenceNumber}
                  onChange={(e) => handleEditChange("sequenceNumber", e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                             focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">{t("examCreate.selectSequence")}</option>
                  {getSequencesForTerm(Number(editForm.term) as TermNumber).map((seq) => {
                    const meta = SEQUENCE_MAP[seq];
                    return (
                      <option key={seq} value={seq}>{t(meta.labelKey)}</option>
                    );
                  })}
                </select>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("common.startDate")}
                  </label>
                  <input
                    type="date"
                    value={editForm.startDate}
                    onChange={(e) => handleEditChange("startDate", e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                               focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("common.endDate")}
                  </label>
                  <input
                    type="date"
                    value={editForm.endDate}
                    onChange={(e) => handleEditChange("endDate", e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                               focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>

              {/* Total Marks & Pass Mark */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("examCreate.totalMarks")} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={editForm.totalMarks}
                    onChange={(e) => handleEditChange("totalMarks", e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-sm
                      focus:outline-none focus:ring-2 focus:ring-primary-500
                      ${editErrors.totalMarks ? "border-red-400" : "border-gray-200"}`}
                  />
                  {editErrors.totalMarks && <p className="text-xs text-red-500 mt-1">{editErrors.totalMarks}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1">
                    {t("academic.passMark")} <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={editForm.passMark}
                    onChange={(e) => handleEditChange("passMark", e.target.value)}
                    className={`w-full px-3 py-2 rounded-xl border text-sm
                      focus:outline-none focus:ring-2 focus:ring-primary-500
                      ${editErrors.passMark ? "border-red-400" : "border-gray-200"}`}
                  />
                  {editErrors.passMark && <p className="text-xs text-red-500 mt-1">{editErrors.passMark}</p>}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("common.description")}
                </label>
                <textarea
                  rows={3}
                  value={editForm.description}
                  onChange={(e) => handleEditChange("description", e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                             focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {/* Instructions */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  {t("examCreate.instructions")}
                </label>
                <textarea
                  rows={2}
                  value={editForm.instructions}
                  onChange={(e) => handleEditChange("instructions", e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm
                             focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditOpen(false)}
                className="px-4 py-2 text-sm font-semibold rounded-xl border-2
                           border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleEditSave}
                disabled={updatingExam}
                className="px-4 py-2 text-sm font-semibold rounded-xl
                           bg-primary-600 text-white hover:bg-primary-700
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updatingExam ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-subject progress */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-900 mb-1">{t("exams.marksProgress")}</h3>
        <p className="text-xs text-gray-400 mb-4">
          {t("exams.marksProgressHint")}
        </p>

        {subjectProgress.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">
            {t("exams.noSubjectsYet")}
          </p>
        ) : (
          <div className="space-y-3">
            {subjectProgress.map(({ sub, entered, total, pct, meta }) => (
              <div key={sub._id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{meta.icon}</span>
                    <span className="text-sm font-semibold text-gray-800">
                      {sub.subjectName}
                    </span>
                    {sub.teacherName && (
                      <span className="text-xs text-gray-400">
                        — {sub.teacherName}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {t("exams.enteredOf", { entered, total })}
                    </span>
                    <span className={`text-xs font-bold px-2 py-0.5
                      rounded-full ${meta.color} ${meta.bg}`}>
                      {t(meta.labelKey)}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all
                      ${pct === 100
                        ? "bg-green-500"
                        : pct > 0
                          ? "bg-primary-500"
                          : "bg-gray-200"
                      }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// SCORE ENTRY PANEL
// ─────────────────────────────────────────────────────────

const ScoreEntryPanel = ({
  sub,
  examId,
  schoolId,
  onClose,
}: {
  sub:      ExamSubject;
  examId:   string;
  schoolId: string;
  onClose:  () => void;
}) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [students, setStudents] = useState<MarkEntryStudent[]>([]);
  const [scores,   setScores]   = useState<Record<string, ScoreEntry>>({});
  const [loading,  setLoading]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [search,   setSearch]   = useState("");
  // Rows that failed validation (out-of-range or missing score). Flagging them
  // inline shows the teacher exactly which cells to fix (e.g. a 23/20 typo or
  // a blank) instead of a blind alert naming nobody.
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());
  const [formError,  setFormError]  = useState("");

  // Stable primitive IDs — prevents double useEffect firing
  const subId     = sub._id;
  const classId   = sub.classId;
  const subjectId = sub.subjectId;
  const maxScore  = sub.maxScore;
  const passMark  = sub.passMark;

  useEffect(() => {
    if (!subId || !classId) return;

    const load = async () => {
      setLoading(true);
      setStudents([]);
      setScores({});
      setSaved(false);
      setInvalidIds(new Set());
      setFormError("");

      try {
        const [stuRes, scoresRes] = await Promise.all([
          // Uses api instance — Authorization header sent automatically
          api.get("/admin/students", {
            params: { schoolId, classId },
          }).catch(() => ({ data: { students: [] } })),

          ExamService.getScores({
            examId,
            subjectId,
            classId,
            schoolId,
          }).catch(() => ({ scores: [] })),
        ]);

        const studentList: MarkEntryStudent[] =
          stuRes.data?.students ||
          stuRes.data?.data     ||
          (Array.isArray(stuRes.data) ? stuRes.data : []);

        setStudents(studentList);

        const map: Record<string, ScoreEntry> = {};
        const scoreRows = (scoresRes as { scores?: RawScoreRow[] } | null)?.scores ?? [];
        for (const s of scoreRows) {
          map[String(s.studentId)] = {
            score:         s.score != null ? String(s.score) : "",
            isAbsent:      s.isAbsent      ?? false,
            teacherRemark: s.teacherRemark || "",
          };
        }
        setScores(map);

      } catch (err) {
        console.warn("[ScoreEntryPanel] load failed:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  // Primitive string deps — stable, no double-firing
  }, [subId, classId, subjectId, examId, schoolId]);

  const updateScore = useCallback((
    studentId: string,
    field: keyof ScoreEntry,
    value: string | boolean
  ) => {
    setScores((prev) => ({
      ...prev,
      [studentId]: { ...(prev[studentId] ?? EMPTY_SCORE), [field]: value },
    }));
    setSaved(false);
    setFormError("");
    setInvalidIds((prev) => {
      if (!prev.has(studentId)) return prev;
      const next = new Set(prev);
      next.delete(studentId);
      return next;
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const records = students.map((s) => {
        const sid   = String(s._id || s.id);
        const entry = scores[sid] ?? EMPTY_SCORE;
        const raw   = String(entry.score ?? "").trim();
        return {
          studentId:     sid,
          score:         raw === "" ? null : Number(raw),
          maxScore,
          isAbsent:      entry.isAbsent      ?? false,
          teacherRemark: entry.teacherRemark || null,
        };
      });

      // A mark of 23/20 must never leave the browser. Number("abc") is NaN,
      // which fails both comparisons, so unparseable cells are caught too.
      const invalid = records.filter(
        (r) =>
          !r.isAbsent && r.score !== null &&
          (!Number.isFinite(r.score) || r.score < 0 || r.score > maxScore)
      );
      if (invalid.length > 0) {
        setInvalidIds(new Set(invalid.map((r) => r.studentId)));
        setFormError(t("exams.invalidScores", { count: invalid.length, max: maxScore }));
        return;
      }

      // A present student must have a score — a blank cell means the sheet is
      // unfinished, so the save is blocked until every row is filled or absent.
      const unentered = records.filter((r) => !r.isAbsent && r.score === null);
      if (unentered.length > 0) {
        setInvalidIds(new Set(unentered.map((r) => r.studentId)));
        setFormError(t("exams.missingScores", { count: unentered.length }));
        return;
      }
      setInvalidIds(new Set());
      setFormError("");

      await ExamService.saveBulkScores({
        examId,
        classId,
        subjectId,
        examSubjectId: subId,
        scores:        records,
        schoolId,
      });
      setSaved(true);
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) || t("exams.saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  const filtered = students.filter((s) => {
    const q = search.toLowerCase();
    return (
      !q ||
      (s.studentName || s.name || "").toLowerCase().includes(q) ||
      (s.admissionNo || "").toLowerCase().includes(q)
    );
  });

  const entered = Object.values(scores).filter(
    (s) => s.isAbsent || (s.score !== "" && s.score != null)
  ).length;

  const progressPct = students.length > 0
    ? Math.round((entered / students.length) * 100)
    : 0;

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden mt-3">

      {/* Panel header */}
      <div className="bg-indigo-50 border-b border-indigo-100
                      px-4 py-3 flex items-center justify-between">
        <div>
          <p className="font-semibold text-indigo-900 text-sm">
            {sub.subjectName} — {t("exams.scoreEntry")}
          </p>
          <p className="text-xs text-indigo-500 mt-0.5">
            {t("exams.scoreEntryMeta", {
              max:     maxScore,
              pass:    passMark,
              entered,
              total:   students.length,
              pct:     progressPct,
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold
              transition-colors disabled:opacity-60
              ${saved
                ? "bg-green-100 text-green-700 border border-green-200"
                : "bg-primary-600 text-white hover:bg-primary-700"
              }`}
          >
            {saving
              ? t("common.saving")
              : saved
                ? `✓ ${t("exams.saved")}`
                : t("exams.saveMarks")}
          </button>
          <button
            onClick={onClose}
            className="text-indigo-400 hover:text-indigo-700
                       text-xl font-bold leading-none px-1"
          >
            ×
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-gray-100">
        <div
          className="h-full bg-primary-500 transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Validation banner (out-of-range or missing scores) */}
      {formError && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-100
                        text-xs font-semibold text-red-700">
          {formError}
        </div>
      )}

      {/* Search */}
      <div className="px-4 py-2 bg-white border-b border-gray-100">
        <input
          type="text"
          placeholder={t("exams.searchStudentPh")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-1.5 border border-gray-200 rounded-lg
                     text-sm focus:outline-none focus:ring-2
                     focus:ring-primary-400"
        />
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[2fr_1fr_80px_100px]
                      bg-gray-50 border-b border-gray-200 px-4 py-2">
        {["academic.student", "academic.admissionNo",
          "academic.absent", "academic.score"].map((labelKey) => (
          <span
            key={labelKey}
            className="text-xs font-bold text-gray-500 uppercase
                       tracking-wide text-center first:text-left"
          >
            {t(labelKey)}
          </span>
        ))}
      </div>

      {/* Rows */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-gray-400">
          {search
            ? t("exams.noStudentsMatch")
            : t("exams.noStudentsInClass")}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          {filtered.map((student, idx) => {
            const sid    = String(student._id || student.id);
            const entry  = scores[sid] ?? EMPTY_SCORE;
            const absent = entry.isAbsent;
            const raw    = String(entry.score ?? "");
            const num    = raw !== "" ? Number(raw) : null;
            const pct    = num != null && !absent
              ? Math.round((num / maxScore) * 100)
              : null;

            const scoreColor =
              absent      ? "text-gray-400" :
              pct == null ? "text-gray-400" :
              pct >= 70   ? "text-green-600" :
              pct >= 50   ? "text-amber-600" :
                            "text-red-600";

            return (
              <div
                key={sid}
                className={`grid grid-cols-[2fr_1fr_80px_100px]
                  px-4 py-2.5 border-b border-gray-50 items-center
                  ${absent
                    ? "bg-red-50"
                    : idx % 2 === 0 ? "bg-white" : "bg-gray-50/40"
                  }`}
              >
                {/* Name */}
                <p className="text-sm font-medium text-gray-900">
                  {student.studentName || student.name || t("results.unknownStudent")}
                </p>

                {/* Admission number */}
                <p className="text-xs text-gray-400 text-center">
                  {student.admissionNo ? `#${student.admissionNo}` : "—"}
                </p>

                {/* Absent toggle */}
                <div className="flex justify-center">
                  <button
                    onClick={() => updateScore(sid, "isAbsent", !absent)}
                    title={absent ? t("exams.markPresent") : t("exams.markAbsent")}
                    className={`w-7 h-7 rounded-lg border-2 flex items-center
                      justify-center text-xs font-bold transition-colors
                      ${absent
                        ? "bg-red-500 border-red-500 text-white"
                        : "border-gray-300 text-transparent hover:border-red-300"
                      }`}
                  >
                    A
                  </button>
                </div>

                {/* Score input */}
                <div className="flex flex-col items-center">
                  {absent ? (
                    <span className="text-xs font-semibold text-gray-400">
                      {t("exams.absent")}
                    </span>
                  ) : (
                    <>
                      <input
                        type="number"
                        value={raw}
                        min={0}
                        max={maxScore}
                        onChange={(e) =>
                          updateScore(sid, "score", e.target.value)
                        }
                        placeholder="—"
                        className={`w-16 text-center px-2 py-1 border
                          rounded-lg text-sm font-bold focus:outline-none
                          focus:ring-2 focus:ring-primary-400 ${scoreColor}
                          ${invalidIds.has(sid)
                            ? "border-red-500 ring-2 ring-red-300"
                            : num != null
                              ? "border-current"
                              : "border-gray-200"
                          }`}
                      />
                      {pct != null && (
                        <span className={`text-xs font-medium mt-0.5
                                         ${scoreColor}`}>
                          {pct}%
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// TAB 2 — MARKS & APPROVAL
// ─────────────────────────────────────────────────────────

const MarksTab = ({
  examId,
  submissions,
  schoolId,
}: {
  examId:      string;
  submissions: ExamSubjectWithTotals[];
  schoolId:    string;
}) => {
  const { t } = useTranslation();
  const { confirm } = useToast();
  const [openSubjectId, setOpenSubjectId] = useState<string | null>(null);
  const [rejectTarget,  setRejectTarget]  = useState<ExamSubject | null>(null);
  const [rejectReason,  setRejectReason]  = useState("");

  // An ExamSubject carries classId and no class name, so the names for the
  // per-class headers are resolved here. Long staleTime: a class list changes
  // once a term, and this is a lookup table, not a view of it.
  const classesQ = useQuery({
    queryKey: ["classes", "for-exam-grouping", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  Boolean(schoolId),
    staleTime: 10 * 60 * 1000,
  });

  const classNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of classesQ.data ?? []) {
      const id = String(c._id ?? c.id ?? "");
      if (id && c.name) map[id] = c.name;
    }
    return map;
  }, [classesQ.data]);

  const groups = useMemo(
    () => groupSubjectsByClass(submissions, classNames, t("exams.unknownClass")),
    [submissions, classNames, t]
  );

  // One class means one section, and a header saying so is just noise.
  const showClassHeaders = groups.length > 1;

  // Coefficient editing. Admin-only, matching the API: a coefficient rescales
  // every student's average, which is a head's decision, not a marker's.
  const role = useAuthStore((s) => s.user?.role ?? "");
  const canEditCoeff = ["admin", "school_admin", "super_admin"].includes(role);
  const [editingCoeff, setEditingCoeff] = useState<string | null>(null);
  const [coeffValue,   setCoeffValue]   = useState("");
  const updateSubjectMut = useUpdateExamSubject(examId);

  const coeffOf = (sub: ExamSubject) =>
    Math.round(((sub.weight ?? 100) / 100) * 100) / 100;

  const saveCoeff = (sub: ExamSubject) => {
    const n = Number(coeffValue);
    if (!Number.isFinite(n) || n <= 0) return;
    updateSubjectMut.mutate(
      { examSubjectId: sub._id, weight: Math.round(n * 100) },
      { onSuccess: () => setEditingCoeff(null) }
    );
  };

  const approve = useApproveSubmission(examId);
  const reject  = useRejectSubmission(examId);

  const toggleSubject = (id: string) =>
    setOpenSubjectId((prev) => (prev === id ? null : id));

  const handleApprove = async (sub: ExamSubject) => {
    const ok = await confirm({
      title:   t("common.confirm"),
      message: t("exams.approveConfirm", { subject: sub.subjectName }),
    });
    if (!ok) return;
    approve.mutate(sub._id);
  };

  const handleRejectConfirm = () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    reject.mutate(
      { examSubjectId: rejectTarget._id, reason: rejectReason.trim() },
      { onSuccess: () => { setRejectTarget(null); setRejectReason(""); } }
    );
  };

  if (submissions.length === 0) {
    return (
      <EmptyState
        icon="📭"
        title={t("exams.noSubjectsShort")}
        subtitle={t("exams.addSubjectsHint")}
      />
    );
  }

  return (
    <>
      {/* Reject modal */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center
                        bg-black/40 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
            <h3 className="font-bold text-gray-900 text-lg mb-1">
              {t("exams.rejectSubmission")}
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              {rejectTarget.subjectName}
              {rejectTarget.teacherName ? ` — ${rejectTarget.teacherName}` : ""}
            </p>
            <textarea
              autoFocus
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("exams.rejectReasonPh")}
              className="w-full border border-gray-200 rounded-xl p-3
                         text-sm focus:outline-none focus:ring-2
                         focus:ring-red-400 resize-none"
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason("");
                }}
                className="flex-1 py-2.5 bg-gray-100 text-gray-700
                           rounded-xl text-sm font-semibold"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleRejectConfirm}
                disabled={!rejectReason.trim() || reject.isPending}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl
                           text-sm font-semibold disabled:opacity-50"
              >
                {reject.isPending ? t("exams.rejecting") : t("exams.reject")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subject rows */}
      <div className="space-y-2">
        <p className="text-xs text-gray-400 font-medium mb-3">
          {t("exams.marksHint")}
        </p>

        {groups.map((group) => (
          <div key={group.classId ?? "no-class"} className="space-y-2">
            {showClassHeaders && (
              <div className="flex items-center gap-2 pt-3 first:pt-0">
                <h3 className="text-xs font-semibold uppercase tracking-wide
                               text-indigo-700 shrink-0">
                  {group.className}
                </h3>
                <span className="text-[11px] font-medium text-gray-400 tabular-nums">
                  {group.items.length}
                </span>
                <span className="flex-1 border-t border-gray-100" />
              </div>
            )}

            {group.items.map((sub) => {
          const meta    = SUBMISSION_META[sub.submissionStatus] ?? SUBMISSION_META.pending;
          const isOpen  = openSubjectId === sub._id;
          const entered = sub.totalScoresEntered ?? 0;
          const total   = sub.totalStudents      ?? 0;
          const pct     = total > 0 ? Math.round((entered / total) * 100) : 0;

          return (
            <div key={sub._id}>
              <div
                className={`bg-white rounded-xl border transition-colors
                  cursor-pointer select-none
                  ${isOpen
                    ? "border-indigo-300 shadow-sm"
                    : "border-gray-100 hover:border-gray-200"
                  }`}
              >
                <div
                  className="flex items-center gap-4 p-4"
                  onClick={() => toggleSubject(sub._id)}
                >
                  <span className="text-xl shrink-0">{meta.icon}</span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-900 text-sm">
                        {sub.subjectName}
                      </span>
                      <span className={`text-xs font-bold px-2 py-0.5
                        rounded-full ${meta.color} ${meta.bg}`}>
                        {t(meta.labelKey)}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-gray-400">
                        {sub.teacherName || t("exams.noTeacherAssigned")}
                      </span>
                      <span className="text-xs text-gray-300">·</span>
                      <span className="text-xs text-gray-400">
                        {t("exams.scoresEntered", { entered, total })}
                      </span>
                      <span className="text-xs text-gray-300">·</span>
                      {editingCoeff === sub._id ? (
                        <span
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-xs text-gray-400">
                            {t("exams.coeff")}
                          </span>
                          <input
                            type="number"
                            min={0.5}
                            step={0.5}
                            value={coeffValue}
                            onChange={(e) => setCoeffValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveCoeff(sub);
                              if (e.key === "Escape") setEditingCoeff(null);
                            }}
                            autoFocus
                            className="w-14 px-1.5 py-0.5 text-xs border
                                       border-indigo-300 rounded-md
                                       focus:outline-none"
                          />
                          <button
                            onClick={() => saveCoeff(sub)}
                            disabled={updateSubjectMut.isPending}
                            className="text-xs font-bold text-green-600
                                       hover:text-green-700 px-1"
                            title={t("common.save")}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => setEditingCoeff(null)}
                            className="text-xs font-bold text-gray-400
                                       hover:text-gray-600 px-1"
                            title={t("common.cancel")}
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <span
                          className="text-xs text-gray-400 flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t("exams.coeff")} {coeffOf(sub)}
                          {canEditCoeff && (
                            <button
                              onClick={() => {
                                setEditingCoeff(sub._id);
                                setCoeffValue(String(coeffOf(sub)));
                              }}
                              className="text-indigo-400 hover:text-indigo-600"
                              title={t("examCreate.coefficient")}
                            >
                              ✎
                            </button>
                          )}
                        </span>
                      )}
                    </div>

                    <div className="mt-2 h-1 bg-gray-100 rounded-full w-48">
                      <div
                        className={`h-full rounded-full transition-all
                          ${pct === 100 ? "bg-green-500" : "bg-primary-400"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  <div
                    className="flex gap-2 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {sub.submissionStatus === "submitted" && (
                      <>
                        <button
                          onClick={() => handleApprove(sub)}
                          disabled={approve.isPending}
                          className="text-xs font-semibold px-3 py-1.5
                                     bg-green-600 text-white rounded-lg
                                     hover:bg-green-700 disabled:opacity-50
                                     transition-colors"
                        >
                          {t("exams.approve")}
                        </button>
                        <button
                          onClick={() => setRejectTarget(sub)}
                          className="text-xs font-semibold px-3 py-1.5
                                     bg-red-600 text-white rounded-lg
                                     hover:bg-red-700 transition-colors"
                        >
                          {t("exams.reject")}
                        </button>
                      </>
                    )}

                    <span className={`text-gray-400 text-lg leading-none
                      transition-transform duration-200
                      ${isOpen ? "rotate-90" : ""}`}>
                      ›
                    </span>
                  </div>
                </div>

                {sub.submissionStatus === "rejected" && sub.rejectReason && (
                  <div className="mx-4 mb-3 px-3 py-2 bg-red-50 rounded-lg
                                  text-xs text-red-600 border border-red-100">
                    ❌ {t("exams.rejectedReason", { reason: sub.rejectReason })}
                  </div>
                )}
              </div>

              {isOpen && (
                <ScoreEntryPanel
                  sub={sub}
                  examId={examId}
                  schoolId={schoolId}
                  onClose={() => setOpenSubjectId(null)}
                />
              )}
            </div>
          );
            })}
          </div>
        ))}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────
// TAB 3 — RESULTS
// ─────────────────────────────────────────────────────────

const ResultsTab = ({
  examId,
  examStatus,
  submissions,
}: {
  examId:      string;
  schoolId:    string;
  examStatus:  ExamStatus;
  submissions: ExamSubjectWithTotals[];
}) => {
  const { t } = useTranslation();
  const { confirm } = useToast();
  const { data: resultsData, isLoading } = useExamResults(examId);
  const { data: statsData }              = useExamStats(examId);
  const processResults                   = useProcessResults();
  const publishResults                   = usePublishResults();

  const results = resultsData?.results ?? [];
  const stats   = statsData?.data;

  const allMarksEntered = submissions.length > 0 &&
    submissions.every(
      (s) =>
        s.submissionStatus === "approved" ||
        (s.totalScoresEntered ?? 0) === (s.totalStudents ?? 0)
    );
  const resultsProcessed = results.length > 0;
  const resultsPublished = examStatus === "published";

  const currentStep =
    !allMarksEntered  ? 1 :
    !resultsProcessed ? 2 :
    !resultsPublished ? 3 : 4;

  const handleProcess = async () => {
    const ok = await confirm({
      title:   t("common.confirm"),
      message: t("exams.processConfirm"),
    });
    if (!ok) return;
    processResults.mutate({ examId });
  };

  const handlePublish = async () => {
    const ok = await confirm({
      title:   t("common.confirm"),
      message: t("exams.publishConfirm"),
    });
    if (!ok) return;
    publishResults.mutate(examId);
  };

  return (
    <div className="space-y-5">

      {/* Guided steps */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-900 mb-4">{t("exams.checklist")}</h3>

        <div className="space-y-3">

          {/* Step 1 */}
          <div className={`flex items-start gap-3 p-3 rounded-xl
            ${allMarksEntered ? "bg-green-50" : "bg-amber-50"}`}>
            <span className="text-lg mt-0.5">
              {allMarksEntered ? "✅" : "⏳"}
            </span>
            <div className="flex-1">
              <p className={`text-sm font-semibold
                ${allMarksEntered ? "text-green-800" : "text-amber-800"}`}>
                {t("exams.step1Title")}
              </p>
              <p className={`text-xs mt-0.5
                ${allMarksEntered ? "text-green-600" : "text-amber-600"}`}>
                {allMarksEntered
                  ? t("exams.step1Done")
                  : t("exams.step1Todo")}
              </p>
              {!allMarksEntered && (
                <Link
                  to={`/exams/${examId}?tab=marks`}
                  className="inline-block mt-2 text-xs font-semibold
                             text-amber-700 underline"
                >
                  → {t("exams.goToMarksTab")}
                </Link>
              )}
            </div>
          </div>

          {/* Step 2 */}
          <div className={`flex items-start gap-3 p-3 rounded-xl
            ${resultsProcessed
              ? "bg-green-50"
              : currentStep === 2
                ? "bg-indigo-50"
                : "bg-gray-50 opacity-60"
            }`}>
            <span className="text-lg mt-0.5">
              {resultsProcessed ? "✅" : "🧮"}
            </span>
            <div className="flex-1">
              <p className={`text-sm font-semibold
                ${resultsProcessed ? "text-green-800" : "text-indigo-800"}`}>
                {t("exams.step2Title")}
              </p>
              <p className={`text-xs mt-0.5
                ${resultsProcessed ? "text-green-600" : "text-indigo-500"}`}>
                {resultsProcessed
                  ? t("exams.step2Done")
                  : t("exams.step2Todo")}
              </p>
              {!resultsProcessed && currentStep === 2 && (
                <button
                  onClick={handleProcess}
                  disabled={processResults.isPending}
                  className="mt-2 px-4 py-1.5 bg-indigo-600 text-white
                             text-xs font-bold rounded-lg hover:bg-indigo-700
                             disabled:opacity-60 transition-colors"
                >
                  {processResults.isPending ? t("exams.calculating") : t("exams.calculateResults")}
                </button>
              )}
            </div>
          </div>

          {/* Step 3 */}
          <div className={`flex items-start gap-3 p-3 rounded-xl
            ${resultsPublished
              ? "bg-green-50"
              : currentStep === 3
                ? "bg-purple-50"
                : "bg-gray-50 opacity-60"
            }`}>
            <span className="text-lg mt-0.5">
              {resultsPublished ? "✅" : "📢"}
            </span>
            <div className="flex-1">
              <p className={`text-sm font-semibold
                ${resultsPublished ? "text-green-800" : "text-purple-800"}`}>
                {t("exams.step3Title")}
              </p>
              <p className={`text-xs mt-0.5
                ${resultsPublished ? "text-green-600" : "text-purple-500"}`}>
                {resultsPublished
                  ? t("exams.step3Done")
                  : t("exams.step3Todo")}
              </p>
              {!resultsPublished && currentStep === 3 && (
                <button
                  onClick={handlePublish}
                  disabled={publishResults.isPending}
                  className="mt-2 px-4 py-1.5 bg-purple-600 text-white
                             text-xs font-bold rounded-lg hover:bg-purple-700
                             disabled:opacity-60 transition-colors"
                >
                  {publishResults.isPending ? t("exams.publishing") : t("exams.publishResults")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { id: "students", label: t("academic.student_other"), value: stats.totalStudents,  color: "text-primary-600" },
            { id: "passed",   label: t("results.passed"),         value: stats.passed,         color: "text-green-600"   },
            { id: "failed",   label: t("results.failed"),         value: stats.failed,         color: "text-red-600"     },
            { id: "passRate", label: t("exams.passRate"),         value: `${stats.passRate}%`, color: "text-amber-600"   },
          ].map((s) => (
            <div key={s.id}
                 className="bg-white rounded-xl border border-gray-100
                            p-4 text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 font-medium mt-1">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Rankings table */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : results.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100">
          <EmptyState
            icon="📊"
            title={t("exams.noResultsYet")}
            subtitle={
              currentStep === 1
                ? t("exams.enterMarksFirst")
                : t("exams.clickCalculate")
            }
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100
                        overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex
                          items-center justify-between">
            <h3 className="font-semibold text-gray-900">
              {t("exams.rankingsCount", { count: results.length })}
            </h3>
            <Link
              to={`/exams/results?examId=${examId}`}
              className="text-xs font-semibold text-primary-600
                         hover:text-primary-700"
            >
              {t("exams.fullDashboard")} →
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-bold text-gray-500
                                uppercase tracking-wide">
                <tr>
                  {["results.pos", "academic.student", "academic.class",
                    "academic.score", "academic.average", "academic.grade",
                    "reportCards.result"].map((labelKey) => (
                    <th key={labelKey}
                        className="px-4 py-3 text-left last:text-center">
                      {t(labelKey)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {results.map((r, idx) => {
                  const pos     = r.classPosition ?? idx + 1;
                  const passing = r.isPassing;
                  const color   = passing ? "text-green-600" : "text-red-600";
                  return (
                    <tr key={r._id || r.studentId}
                        className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className={`font-bold text-base
                          ${pos === 1 ? "text-yellow-500" :
                            pos === 2 ? "text-gray-400"   :
                            pos === 3 ? "text-amber-600"  :
                                        "text-gray-700"}`}>
                          #{pos}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">
                          {r.studentName || t("results.unknownStudent")}
                        </p>
                        {r.admissionNo && (
                          <p className="text-xs text-gray-400">
                            #{r.admissionNo}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {r.className || "—"}
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {r.totalScore}/{r.maxTotalScore}
                      </td>
                      <td className={`px-4 py-3 font-bold ${color}`}>
                        {r.percentage?.toFixed(1)}%
                      </td>
                      <td className={`px-4 py-3 font-bold ${color}`}>
                        {r.overallGrade || "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex px-2 py-0.5
                          rounded-full text-xs font-bold
                          ${passing
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                          }`}>
                          {passing ? t("results.pass") : t("results.fail")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function ExamDetailPage() {
  const { t } = useTranslation();
  const { confirm } = useToast();
  const { id }         = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();
  const schoolId       = useAuthStore((s) => s.user?.schoolId ?? "");

  const initialTab                = (searchParams.get("tab") as Tab) ?? "details";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const { data, isLoading, error } = useExamDetail(id ?? "");
  const { data: subData }          = useSubmissions(id ?? "");
  const updateStatus               = useUpdateExamStatus();
  const updateExam                 = useUpdateExam();

  const exam        = data?.exam;
  const submissions = (subData?.submissions ?? []) as ExamSubjectWithTotals[];

  // Keep tab in sync with ?tab= URL param
  useEffect(() => {
    const tab = searchParams.get("tab") as Tab;
    if (tab && TABS.find((tb) => tb.key === tab)) setActiveTab(tab);
  }, [searchParams]);

  const handleStatusChange = async (status: ExamStatus) => {
    if (!id) return;
    const ok = await confirm({
      title:   t("common.confirm"),
      message: t("exams.statusChangeConfirm", {
        status: t(EXAM_STATUS_META[status].labelKey),
      }),
    });
    if (!ok) return;
    updateStatus.mutate({ examId: id, status });
  };

  const handleUpdateExam = (data: Record<string, unknown>) => {
    if (!id) return;
    updateExam.mutate({ examId: id, data });
  };

  const awaitingApproval = submissions.filter(
    (s) => s.submissionStatus === "submitted"
  ).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="text-center py-16">
        <p className="text-5xl mb-4">😕</p>
        <p className="font-semibold text-gray-700">{t("exams.notFound")}</p>
        <button
          onClick={() => navigate("/exams")}
          className="mt-4 px-6 py-2 bg-primary-600 text-white
                     rounded-xl text-sm font-semibold"
        >
          {t("exams.backToExams")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate("/exams")}
            className="text-sm text-gray-400 hover:text-gray-600 mb-1 block"
          >
            ← {t("exams.backToExams")}
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{exam.name}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {examTypeLabel(t, exam.type)}
            {exam.academicYear ? ` · ${exam.academicYear}` : ""}
            {exam.term         ? ` · ${exam.term}`         : ""}
          </p>
        </div>
        <StatusBadge status={exam.status} />
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`relative px-5 py-3 text-sm font-semibold
              transition-colors
              ${activeTab === tab.key
                ? "text-primary-600 border-b-2 border-primary-600"
                : "text-gray-500 hover:text-gray-700"
              }`}
          >
            {t(tab.labelKey)}

            {tab.key === "marks" && awaitingApproval > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs
                               font-bold px-1.5 py-0.5 rounded-full">
                {awaitingApproval}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "details" && (
          <DetailsTab
            exam={exam}
            submissions={submissions}
            onStatusChange={handleStatusChange}
            changingStatus={updateStatus.isPending}
            onUpdateExam={handleUpdateExam}
            updatingExam={updateExam.isPending}
          />
        )}

        {activeTab === "marks" && (
          <MarksTab
            examId={id ?? ""}
            submissions={submissions}
            schoolId={schoolId}
          />
        )}

        {activeTab === "results" && (
          <ResultsTab
            examId={id ?? ""}
            schoolId={schoolId}
            examStatus={exam.status}
            submissions={submissions}
          />
        )}
      </div>
    </div>
  );
}