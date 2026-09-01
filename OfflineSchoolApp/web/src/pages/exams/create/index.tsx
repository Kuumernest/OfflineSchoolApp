// web/src/pages/exams/create/index.tsx
import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import { useCreateExam } from "@/hooks/useExams";
import type { ExamType, ExamStatus, SequenceNumber, TermNumber } from "@/types/exam.types";
// "../../lib/api" resolves to src/pages/lib/api, which does not exist.
import api, { getErrorMessage } from "@/lib/axios";
import { useTranslation } from "react-i18next";

import {
  EXAM_TYPE_KEYS,
  SEQUENCE_MAP,
  getSequencesForTerm,
  TERM_OPTIONS,
  ACADEMIC_YEAR_OPTIONS,
  examTypeLabel,
} from "@/constants/exam.constants";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface ClassOption { _id: string; name: string }
interface SubjectOption { _id: string; name: string }
interface TeacherOption { _id: string; name: string; email: string }

interface SubjectAssignment {
subjectId: string;
subjectName: string;
teacherId: string | null;
maxScore: number;
passMark: number;
}

interface ClassAssignment {
classId: string;
className: string;
subjects: Record<string, SubjectAssignment>;
}

// ─────────────────────────────────────────────────────────
// STEP INDICATOR
// ─────────────────────────────────────────────────────────

const STEPS = ["Details", "Classes & Subjects", "Review"] as const;
type Step = 0 | 1 | 2;

const StepIndicator = ({ current }: { current: Step }) => (

<div className="flex items-center justify-center gap-0 mb-8"> {STEPS.map((label, i) => { const done = i < current; const active = i === current; return ( <div key={label} className="flex items-center"> <div className="flex flex-col items-center"> <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all ${done ? "bg-green-500 border-green-500 text-white" : active ? "bg-primary-600 border-primary-600 text-white" : "bg-white border-gray-300 text-gray-400"}`} > {done ? "✓" : i + 1} </div> <span className={`text-xs mt-1 font-medium ${active ? "text-primary-600" : done ? "text-green-600" : "text-gray-400"}`}> {label} </span> </div> {i < STEPS.length - 1 && ( <div className={`w-20 h-0.5 mb-5 mx-2 transition-colors ${done ? "bg-green-400" : "bg-gray-200"}`} /> )} </div> ); })} </div> );
// ─────────────────────────────────────────────────────────
// STEP 1 — DETAILS
// ─────────────────────────────────────────────────────────

interface DetailsForm {
name: string;
type: ExamType;
sequenceNumber: string;
academicYear: string;
term: string;
status: string;
startDate: string;
endDate: string;
totalMarks: string;
passMark: string;
description: string;
instructions: string;
}

const StepDetails = ({
form,
onChange,
errors,
}: {
form: DetailsForm;
onChange: (field: keyof DetailsForm, value: string) => void;
errors: Partial<Record<keyof DetailsForm, string>>;
}) => {
  const { t } = useTranslation();
const tm = Number(form.totalMarks);
const pm = Number(form.passMark);
const passRate = tm > 0 ? ((pm / tm) * 100).toFixed(1) : null;

return (
<div className="space-y-6">

  {/* Name */}
  <div>
    <label className="block text-sm font-semibold text-gray-700 mb-1">
      {t("examCreate.name")} <span className="text-red-500">*</span>
    </label>
    <input
      type="text"
      value={form.name}
      onChange={(e) => onChange("name", e.target.value)}
      placeholder={t("examCreate.namePh")}
      className={`w-full px-4 py-2.5 rounded-xl border text-sm
        focus:outline-none focus:ring-2 focus:ring-primary-500
        ${errors.name ? "border-red-400" : "border-gray-200"}`}
    />
    {errors.name && (
      <p className="text-red-500 text-xs mt-1">{errors.name}</p>
    )}
  </div>

  {/* Type */}
  <div>
    <label className="block text-sm font-semibold text-gray-700 mb-2">
      {t("examCreate.type")} <span className="text-red-500">*</span>
    </label>
    <div className="flex flex-wrap gap-2">
      {(Object.entries(EXAM_TYPE_KEYS) as [ExamType, string][]).map(([value, labelKey]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange("type", value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold
            border transition-colors
            ${form.type === value
              ? "bg-primary-600 border-primary-600 text-white"
              : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
            }`}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  </div>

  {/* Sequence (only for test / promotion_exam) */}
  {form.type !== "practical" && (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">
        Sequence <span className="text-red-500">*</span>
      </label>
      <div className="flex flex-wrap gap-2">
        {getSequencesForTerm(Number(form.term) as TermNumber).map((seq) => {
          const meta = SEQUENCE_MAP[seq];
          const isPromo = seq === 5 || seq === 6;
          return (
            <button
              key={seq}
              type="button"
              onClick={() => onChange("sequenceNumber", String(seq))}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold
                border transition-colors
                ${form.sequenceNumber === String(seq)
                  ? "bg-primary-600 border-primary-600 text-white"
                  : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                }`}
            >
              {t(meta.labelKey)}{isPromo ? " *" : ""}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-1">
        * Sequence 5 &amp; 6 can be configured as promotion exams
      </p>
    </div>
  )}

  {/* Academic year + term */}
  <div className="grid grid-cols-2 gap-4">
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">
        {t("academic.schoolYear")} <span className="text-red-500">*</span>
      </label>
      <div className="flex flex-wrap gap-2">
        {ACADEMIC_YEAR_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange("academicYear", opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold
              border transition-colors
              ${form.academicYear === opt.value
                ? "bg-primary-600 border-primary-600 text-white"
                : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
              }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">
        {t("academic.term")} <span className="text-red-500">*</span>
      </label>
      <div className="flex flex-wrap gap-2">
        {TERM_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange("term", opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold
              border transition-colors
              ${form.term === opt.value
                ? "bg-primary-600 border-primary-600 text-white"
                : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
              }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    </div>
  </div>

  {/* Dates */}
  <div className="grid grid-cols-2 gap-4">
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        {t("common.startDate")}
      </label>
      <input
        type="date"
        value={form.startDate}
        onChange={(e) => onChange("startDate", e.target.value)}
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200
          text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
    </div>
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        {t("common.endDate")}
      </label>
      <input
        type="date"
        value={form.endDate}
        onChange={(e) => onChange("endDate", e.target.value)}
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200
          text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
      {errors.endDate && (
        <p className="text-red-500 text-xs mt-1">{errors.endDate}</p>
      )}
    </div>
  </div>

  {/* Marks */}
  <div className="grid grid-cols-2 gap-4">
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        {t("examCreate.totalMarks")} <span className="text-red-500">*</span>
      </label>
      <input
        type="number"
        value={form.totalMarks}
        onChange={(e) => onChange("totalMarks", e.target.value)}
        min="1"
        className={`w-full px-4 py-2.5 rounded-xl border text-sm
          focus:outline-none focus:ring-2 focus:ring-primary-500
          ${errors.totalMarks ? "border-red-400" : "border-gray-200"}`}
      />
      {errors.totalMarks && (
        <p className="text-red-500 text-xs mt-1">{errors.totalMarks}</p>
      )}
    </div>
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        {t("examCreate.passMark")} <span className="text-red-500">*</span>
      </label>
      <input
        type="number"
        value={form.passMark}
        onChange={(e) => onChange("passMark", e.target.value)}
        min="0"
        className={`w-full px-4 py-2.5 rounded-xl border text-sm
          focus:outline-none focus:ring-2 focus:ring-primary-500
          ${errors.passMark ? "border-red-400" : "border-gray-200"}`}
      />
      {errors.passMark && (
        <p className="text-red-500 text-xs mt-1">{errors.passMark}</p>
      )}
    </div>
  </div>

  {passRate && (
    <div className="flex items-center gap-2 bg-primary-50 rounded-xl
                    px-4 py-3 text-primary-700 text-sm font-medium">
      ℹ️ Pass rate: {passRate}%
    </div>
  )}

  {/* Status */}
  <div>
    <label className="block text-sm font-semibold text-gray-700 mb-2">
      {t("examCreate.initialStatus")}
    </label>
    <div className="flex gap-2">
      {[
        { value: "draft",     label: "Draft"     },
        { value: "scheduled", label: "Scheduled" },
      ].map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange("status", opt.value)}
          className={`px-4 py-2 rounded-lg text-sm font-semibold
            border transition-colors
            ${form.status === opt.value
              ? "bg-primary-600 border-primary-600 text-white"
              : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
            }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>

  {/* Description */}
  <div>
    <label className="block text-sm font-semibold text-gray-700 mb-1">
      {t("common.description")}
      <span className="text-gray-400 font-normal ml-1">(optional)</span>
    </label>
    <textarea
      value={form.description}
      onChange={(e) => onChange("description", e.target.value)}
      rows={3}
      placeholder={t("examCreate.descriptionPh")}
      className="w-full px-4 py-2.5 rounded-xl border border-gray-200
        text-sm focus:outline-none focus:ring-2 focus:ring-primary-500
        resize-none"
    />
  </div>

  {/* Instructions */}
  <div>
    <label className="block text-sm font-semibold text-gray-700 mb-1">
      {t("common.instructions")}
      <span className="text-gray-400 font-normal ml-1">(optional)</span>
    </label>
    <textarea
      value={form.instructions}
      onChange={(e) => onChange("instructions", e.target.value)}
      rows={3}
      placeholder={t("examCreate.instructionsPh")}
      className="w-full px-4 py-2.5 rounded-xl border border-gray-200
        text-sm focus:outline-none focus:ring-2 focus:ring-primary-500
        resize-none"
    />
  </div>
</div>
);
};

// ─────────────────────────────────────────────────────────
// STEP 2 — CLASSES & SUBJECTS
// ─────────────────────────────────────────────────────────

const StepClassesSubjects = ({
schoolId,
assignments,
setAssignments,
totalMarks,
passMark,
}: {
schoolId: string;
assignments: Record<string, ClassAssignment>;
setAssignments: React.Dispatch<React.SetStateAction<Record<string, ClassAssignment>>>;
totalMarks: number;
passMark: number;
}) => {
  const { t } = useTranslation();
const [classes, setClasses] = useState<ClassOption[]>([]);
const [subjects, setSubjects] = useState<SubjectOption[]>([]);
const [teachers, setTeachers] = useState<TeacherOption[]>([]);
const [classTeacherMap, setClassTeacherMap] = useState<Record<string, string>>({});
const [loading, setLoading] = useState(true);
const [activeClass, setActiveClass] = useState<string | null>(null);
const [subjectSearch, setSubjectSearch] = useState("");

useEffect(() => {
const load = async () => {
try {
const [clsRes, tchRes] = await Promise.all([
api.get("/admin/classes", { params: { schoolId } }),
api.get("/admin/teachers", { params: { schoolId } }),
]);
setClasses(
clsRes.data?.classes ||
(Array.isArray(clsRes.data) ? clsRes.data : [])
);
setTeachers(
tchRes.data?.teachers ||
(Array.isArray(tchRes.data) ? tchRes.data : [])
);
} catch {
// silent
} finally {
setLoading(false);
}
};
load();
}, [schoolId]);

// Load subjects when class selected
useEffect(() => {
if (!activeClass) { setSubjects([]); setClassTeacherMap({}); return; }
api.get("/admin/subjects", {
params: { schoolId, classId: activeClass },
}).then((res) => {
const body = res.data as { subjects?: SubjectOption[] } | SubjectOption[] | undefined;
setSubjects(
Array.isArray(body) ? body : body?.subjects ?? []
);
}).catch(() => setSubjects([]));

// Load teacher assignments for this class to auto-fill teachers
api.get("/admin/teacher-assignments", {
params: { schoolId, classId: activeClass },
}).then((res) => {
const assignments = res.data?.assignments || (Array.isArray(res.data) ? res.data : []);
const map: Record<string, string> = {};
for (const a of assignments) {
  if (a.subjectId && a.teacherId) {
    map[a.subjectId] = a.teacherId;
  }
}
setClassTeacherMap(map);
}).catch(() => setClassTeacherMap({}));
}, [activeClass, schoolId]);

const toggleClass = (cls: ClassOption) => {
const cid = cls._id;
setAssignments((prev) => {
if (prev[cid]) {
const next = { ...prev };
delete next[cid];
return next;
}
return {
...prev,
[cid]: { classId: cid, className: cls.name, subjects: {} },
};
});
};

const toggleSubject = (sub: SubjectOption) => {
if (!activeClass) return;
const cid = activeClass;
const sid = sub._id;
setAssignments((prev) => {
const cls = prev[cid];
if (!cls) return prev;
if (cls.subjects[sid]) {
const { [sid]: _, ...rest } = cls.subjects;
return { ...prev, [cid]: { ...cls, subjects: rest } };
}
return {
...prev,
[cid]: {
...cls,
subjects: {
...cls.subjects,
[sid]: {
  subjectId: sid,
  subjectName: sub.name,
  teacherId: classTeacherMap[sid] || null,
  maxScore: totalMarks,
  passMark,
},
},
},
};
});
};

const updateSubject = (
cid: string,
sid: string,
field: keyof SubjectAssignment,
value: string | number | null
) => {
setAssignments((prev) => ({
...prev,
[cid]: {
...prev[cid],
subjects: {
...prev[cid].subjects,
[sid]: { ...prev[cid].subjects[sid], [field]: value },
},
},
}));
};

const totalSubjects = Object.values(assignments).reduce(
(acc, cls) => acc + Object.keys(cls.subjects).length, 0
);

const filteredSubjects = subjects.filter((s) =>
s.name.toLowerCase().includes(subjectSearch.toLowerCase())
);

if (loading) {
return (
<div className="flex items-center justify-center py-16">
<div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
</div>
);
}

return (
<div className="space-y-4">

  {/* Summary */}
  <div className="flex items-center gap-4 bg-primary-50 rounded-xl
                  p-4 text-sm">
    <div className="text-center">
      <p className="text-xl font-bold text-primary-600">
        {Object.keys(assignments).length}
      </p>
      <p className="text-xs text-gray-500 font-medium">{t("academic.class_other")}</p>
    </div>
    <div className="w-px h-8 bg-primary-200" />
    <div className="text-center">
      <p className="text-xl font-bold text-primary-600">{totalSubjects}</p>
      <p className="text-xs text-gray-500 font-medium">{t("academic.subject_other")}</p>
    </div>
    <p className="text-xs text-gray-500 ml-2">
      Select classes on the left, then tick subjects on the right
    </p>
  </div>

  <div className="flex gap-4 h-96">

    {/* Classes panel */}
    <div className="w-44 shrink-0 border border-gray-200 rounded-xl
                    overflow-hidden">
      <div className="bg-gray-50 px-3 py-2 text-xs font-bold text-gray-500
                      uppercase tracking-wide border-b border-gray-200">
        {t("academic.class_other")}
      </div>
      <div className="overflow-y-auto h-full">
        {classes.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-8">
            {t("classes.none")}
          </p>
        ) : (
          classes.map((cls) => {
            const selected  = !!assignments[cls._id];
            const isActive  = activeClass === cls._id;
            const subCount  = assignments[cls._id]
              ? Object.keys(assignments[cls._id].subjects).length
              : 0;
            return (
              <button
                key={cls._id}
                onClick={() => {
                  setActiveClass(cls._id);
                  setSubjectSearch("");
                  if (!assignments[cls._id]) toggleClass(cls);
                }}
                className={`w-full text-left px-3 py-2.5 text-sm
                  flex items-center justify-between gap-1
                  border-b border-gray-100 transition-colors
                  ${isActive
                    ? "bg-primary-600 text-white"
                    : selected
                      ? "bg-primary-50 text-primary-700"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
              >
                <span className="font-medium truncate text-xs">
                  {cls.name}
                </span>
                {subCount > 0 && (
                  <span className={`text-xs font-bold px-1.5 py-0.5
                    rounded-full shrink-0
                    ${isActive
                      ? "bg-white text-primary-600"
                      : "bg-primary-100 text-primary-700"
                    }`}>
                    {subCount}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>

    {/* Subjects panel */}
    <div className="flex-1 border border-gray-200 rounded-xl overflow-hidden">
      {!activeClass ? (
        <div className="flex items-center justify-center h-full text-gray-400">
          <div className="text-center">
            <p className="text-4xl mb-2">←</p>
            <p className="text-sm">{t("examCreate.selectClassFirst")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200
                          flex items-center gap-2">
            <span className="text-xs font-bold text-gray-500 uppercase
                             tracking-wide flex-1">
              {classes.find((c) => c._id === activeClass)?.name} — Subjects
            </span>
            <button
              type="button"
              onClick={() => {
                if (!activeClass) return;
                const allSelected = filteredSubjects.every(
                  (s) => assignments[activeClass]?.subjects[s._id]
                );
                setAssignments((prev) => {
                  const cls = prev[activeClass];
                  if (!cls) return prev;
                  if (allSelected) {
                    // Deselect all filtered subjects
                    const subjects = { ...cls.subjects };
                    for (const s of filteredSubjects) delete subjects[s._id];
                    return { ...prev, [activeClass]: { ...cls, subjects } };
                  }
                  // Select all filtered subjects
                  const subjects = { ...cls.subjects };
                  for (const s of filteredSubjects) {
                    if (!subjects[s._id]) {
                      subjects[s._id] = {
                        subjectId: s._id,
                        subjectName: s.name,
                        teacherId: classTeacherMap[s._id] || null,
                        maxScore: totalMarks,
                        passMark,
                      };
                    }
                  }
                  return { ...prev, [activeClass]: { ...cls, subjects } };
                });
              }}
              className="text-xs px-2 py-1 rounded-lg font-medium
                         transition-colors
                         bg-primary-100 text-primary-700 hover:bg-primary-200"
            >
              {filteredSubjects.every(
                (s) => assignments[activeClass]?.subjects[s._id]
              )
                ? t("examCreate.deselectAll")
                : t("examCreate.selectAll")}
            </button>
            <input
              type="text"
              placeholder={t("common.searchShort")}
              value={subjectSearch}
              onChange={(e) => setSubjectSearch(e.target.value)}
              className="text-xs px-2 py-1 border border-gray-200
                         rounded-lg w-32 focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto h-full pb-2">
            {filteredSubjects.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-8">
                {t("subjects.none")}
              </p>
            ) : (
              filteredSubjects.map((sub) => {
                const assigned = !!(
                  activeClass &&
                  assignments[activeClass]?.subjects[sub._id]
                );
                const entry = activeClass
                  ? assignments[activeClass]?.subjects[sub._id]
                  : null;

                return (
                  <div
                    key={sub._id}
                    className="border-b border-gray-100 last:border-0"
                  >
                    {/* Toggle row */}
                    <button
                      onClick={() => toggleSubject(sub)}
                      className={`w-full text-left px-4 py-2.5 flex
                        items-center gap-3 transition-colors
                        ${assigned
                          ? "bg-primary-50"
                          : "hover:bg-gray-50"
                        }`}
                    >
                      <div className={`w-4 h-4 rounded border-2
                        shrink-0 flex items-center justify-center
                        transition-colors
                        ${assigned
                          ? "bg-primary-600 border-primary-600"
                          : "border-gray-300"
                        }`}>
                        {assigned && (
                          <span className="text-white text-xs">✓</span>
                        )}
                      </div>
                      <span className={`text-sm font-medium
                        ${assigned
                          ? "text-primary-700"
                          : "text-gray-700"
                        }`}>
                        {sub.name}
                      </span>
                    </button>

                    {/* Config panel */}
                    {assigned && entry && activeClass && (
                      <div className="px-4 pb-3 bg-primary-50 grid
                                      grid-cols-3 gap-2">
                        {/* Teacher */}
                        <div className="col-span-3">
                          <label className="text-xs text-gray-500
                                           font-semibold">
                            {t("academic.teacher")}
                          </label>
                          <select
                            value={entry.teacherId ?? ""}
                            onChange={(e) =>
                              updateSubject(
                                activeClass, sub._id,
                                "teacherId", e.target.value || null
                              )
                            }
                            className="w-full mt-1 px-2 py-1.5 text-xs
                              border border-gray-200 rounded-lg
                              focus:outline-none bg-white"
                          >
                            <option value="">{t("examCreate.noTeacher")}</option>
                            {teachers.map((t) => (
                              <option key={t._id} value={t._id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {/* Max score */}
                        <div>
                          <label className="text-xs text-gray-500
                                           font-semibold">
                            {t("examCreate.max")}
                          </label>
                          <input
                            type="number"
                            value={entry.maxScore}
                            onChange={(e) =>
                              updateSubject(
                                activeClass, sub._id,
                                "maxScore", Number(e.target.value)
                              )
                            }
                            className="w-full mt-1 px-2 py-1.5 text-xs
                              border border-gray-200 rounded-lg
                              focus:outline-none"
                          />
                        </div>
                        {/* Pass mark */}
                        <div>
                          <label className="text-xs text-gray-500
                                           font-semibold">
                            {t("examCreate.pass")}
                          </label>
                          <input
                            type="number"
                            value={entry.passMark}
                            onChange={(e) =>
                              updateSubject(
                                activeClass, sub._id,
                                "passMark", Number(e.target.value)
                              )
                            }
                            className="w-full mt-1 px-2 py-1.5 text-xs
                              border border-gray-200 rounded-lg
                              focus:outline-none"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  </div>
</div>
);
};

// ─────────────────────────────────────────────────────────
// STEP 3 — REVIEW
// ─────────────────────────────────────────────────────────

const StepReview = ({
form,
assignments,
}: {
form: DetailsForm;
assignments: Record<string, ClassAssignment>;
}) => {
  const { t } = useTranslation();
const totalSubjects = Object.values(assignments).reduce(
(acc, cls) => acc + Object.keys(cls.subjects).length, 0
);
return (
<div className="space-y-6">

  {/* Exam summary */}
  <div className="bg-gray-50 rounded-xl p-5">
    <h3 className="font-semibold text-gray-900 mb-4">{t("examCreate.details")}</h3>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
      {[
        { label: t("common.name"),          value: form.name },
        { label: t("common.type"),          value: examTypeLabel(t, form.type) },
        { label: t("academic.schoolYear"), value: form.academicYear },
        { label: t("academic.term"),          value: form.term },
        { label: t("common.status"),        value: form.status },
        { label: t("common.startDate"),    value: form.startDate || "—" },
        { label: t("common.endDate"),      value: form.endDate   || "—" },
        { label: t("examCreate.totalMarks"),   value: form.totalMarks },
        { label: t("examCreate.passMark"),     value: form.passMark },
      ].map(({ label, value }) => (
        <div key={label} className="flex justify-between border-b
                                    border-gray-200 pb-2">
          <dt className="text-gray-500 font-medium">{label}</dt>
          <dd className="font-semibold text-gray-900">{value}</dd>
        </div>
      ))}
    </dl>
  </div>

  {/* Assignments */}
  <div>
    <div className="flex items-center justify-between mb-3">
      <h3 className="font-semibold text-gray-900">{t("examCreate.subjectAssignments")}</h3>
      <span className="text-xs bg-primary-100 text-primary-700
                       font-bold px-3 py-1 rounded-full">
        {Object.keys(assignments).length} class(es) ·
        {totalSubjects} subject(s)
      </span>
    </div>

    {Object.keys(assignments).length === 0 ? (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4
                      text-amber-700 text-sm text-center">
        ⚠️ No subjects assigned. You can add them later from the exam detail.
      </div>
    ) : (
      <div className="space-y-3">
        {Object.values(assignments).map((cls) => (
          <div key={cls.classId} className="border border-gray-200
                                            rounded-xl overflow-hidden">
            <div className="bg-primary-50 px-4 py-2 flex items-center
                            justify-between">
              <span className="font-semibold text-primary-700 text-sm">
                {cls.className}
              </span>
              <span className="text-xs text-gray-500">
                {Object.keys(cls.subjects).length} subject(s)
              </span>
            </div>
            <div className="divide-y divide-gray-100">
              {Object.values(cls.subjects).map((sub) => (
                <div key={sub.subjectId}
                     className="px-4 py-2 flex items-center justify-between
                                text-sm">
                  <span className="font-medium text-gray-800">
                    {sub.subjectName}
                  </span>
                  <span className="text-gray-400 text-xs">
                    Max {sub.maxScore} · Pass {sub.passMark}
                  </span>
                </div>
              ))}
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
// MAIN PAGE
// ─────────────────────────────────────────────────────────

const currentYear = new Date().getFullYear();

export default function CreateExamPage() {
  const { t } = useTranslation();
const navigate = useNavigate();
const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
const createExam = useCreateExam();

const [step, setStep] = useState<Step>(0);

const [form, setForm] = useState<DetailsForm>({
name: "",
type: "test",
sequenceNumber: "",
academicYear: `${currentYear}/${currentYear + 1}`,
term: "1",
status: "draft",
startDate: "",
endDate: "",
totalMarks: "100",
passMark: "50",
description: "",
instructions: "",
});

  const [assignments, setAssignments] = useState<
    Record<string, ClassAssignment>
  >({});

  const [errors, setErrors] = useState<
    Partial<Record<keyof DetailsForm, string>>
  >({});

const onChange = useCallback(
(field: keyof DetailsForm, value: string) => {
setForm((p) => ({ ...p, [field]: value }));
setErrors((p) => ({ ...p, [field]: undefined }));
},
[]
);

const validate = (): boolean => {
const e: typeof errors = {};
if (!form.name.trim()) e.name = "Exam name is required";
const tm = Number(form.totalMarks);
const pm = Number(form.passMark);
if (isNaN(tm) || tm <= 0) e.totalMarks = "Must be a positive number";
if (isNaN(pm) || pm < 0 || pm > tm)
e.passMark = `Must be between 0 and ${tm}`;
if (
form.startDate &&
form.endDate &&
new Date(form.startDate) > new Date(form.endDate)
)
e.endDate = "End date must be after start date";
setErrors(e);
return Object.keys(e).length === 0;
};

const goNext = () => {
if (step === 0 && !validate()) return;
setStep((s) => (s < 2 ? ((s + 1) as Step) : s));
};

const goBack = () => {
if (step === 0) navigate("/exams");
else setStep((s) => (s - 1) as Step);
};

const handleSubmit = async () => {
try {
const result = await createExam.mutateAsync({
name: form.name.trim(),
type: form.type as ExamType,
sequenceNumber: form.sequenceNumber ? (Number(form.sequenceNumber) as SequenceNumber) : null,
academicYear: form.academicYear,
term: Number(form.term) as TermNumber,
status: form.status as ExamStatus,
startDate: form.startDate || "",
endDate: form.endDate || "",
totalMarks: Number(form.totalMarks),
passMark: Number(form.passMark),
description: form.description.trim(),
instructions: form.instructions.trim(),
classIds: Object.keys(assignments),
schoolId, // ✅ add this
});

  const examId =
    result?.exam?._id ||
    result?.exam?.id  ||
    result?.serverId  ||
    result?._id;

  if (!examId) throw new Error("Exam created but no ID returned");

  // Assign subjects
  for (const [classId, cls] of Object.entries(assignments)) {
    for (const [subjectId, sub] of Object.entries(cls.subjects)) {
      try {
        await api.post(`/exams/${examId}/subjects`, {
          subjectId,
          classId,
          teacherId: sub.teacherId || null,
          maxScore:  sub.maxScore,
          passMark:  sub.passMark,
          schoolId,
        });
      } catch {
        // non-fatal
      }
    }
  }

  navigate(`/exams/${examId}`);
} catch (err) {
  alert(getErrorMessage(err) || "Failed to create exam");
}
};

return (
<div className="max-w-3xl mx-auto">

  {/* Header */}
  <div className="mb-6">
    <button
      onClick={goBack}
      className="text-sm text-gray-500 hover:text-gray-700
                 flex items-center gap-1 mb-3"
    >
      ← Back
    </button>
    <h1 className="text-2xl font-bold text-gray-900">{t("examCreate.title")}</h1>
    <p className="text-gray-500 text-sm">
      {t("examCreate.blurb")}
    </p>
  </div>

  <StepIndicator current={step} />

  {/* Card */}
  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
    {step === 0 && (
      <StepDetails
        form={form}
        onChange={onChange}
        errors={errors}
      />
    )}
    {step === 1 && (
      <StepClassesSubjects
        schoolId={schoolId}
        assignments={assignments}
        setAssignments={setAssignments}
        totalMarks={Number(form.totalMarks)}
        passMark={Number(form.passMark)}
      />
    )}
    {step === 2 && (
      <StepReview
        form={form}
        assignments={assignments}
      />
    )}
  </div>

  {/* Navigation */}
  <div className="flex items-center justify-between mt-6">
    <button
      onClick={goBack}
      className="px-6 py-2.5 border border-gray-200 rounded-xl
                 text-sm font-semibold text-gray-600
                 hover:bg-gray-50 transition-colors"
    >
      {step === 0 ? t("common.cancel") : `← ${t("common.back")}`}
    </button>

    {step < 2 ? (
      <button
        onClick={goNext}
        className="px-8 py-2.5 bg-primary-600 hover:bg-primary-700
                   text-white rounded-xl text-sm font-semibold
                   transition-colors"
      >
        {t("exams.next")} →
      </button>
    ) : (
      <button
        onClick={handleSubmit}
        disabled={createExam.isPending}
        className="px-8 py-2.5 bg-green-600 hover:bg-green-700
                   text-white rounded-xl text-sm font-semibold
                   transition-colors disabled:opacity-60
                   flex items-center gap-2"
      >
        {createExam.isPending && (
          <div className="w-4 h-4 border-2 border-white
                         border-t-transparent rounded-full animate-spin" />
        )}
        {createExam.isPending ? t("exams.creating") : `✓ ${t("exams.create")}`}
      </button>
    )}
  </div>
</div>
);
}