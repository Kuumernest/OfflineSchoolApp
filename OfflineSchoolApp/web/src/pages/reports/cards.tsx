// web/src/pages/reports/cards.tsx
import { useState, useEffect } from "react";
import { Link }                from "react-router-dom";
import { useAuthStore }        from "@/store/auth.store";
import { useExams }            from "@/hooks/useExams";
import { EXAM_STATUS_META,
         examTypeLabel }    from "@/constants/exam.constants";
import type { Exam }           from "@/types/exam.types";

import api                     from "@/lib/api";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface ClassOption   { _id: string; name: string }
interface StudentOption { _id: string; name: string; studentName?: string }

// ─────────────────────────────────────────────────────────
// EXAM CARD
// ─────────────────────────────────────────────────────────

const ExamCard = ({
  exam,
  onSelect,
  isSelected,
}: {
  exam:       Exam;
  onSelect:   () => void;
  isSelected: boolean;
}) => {
  const { t } = useTranslation();
  const meta = EXAM_STATUS_META[exam.status] ?? EXAM_STATUS_META.draft;
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-4 rounded-xl border transition-all
        ${isSelected
          ? "border-primary-500 bg-primary-50 shadow-md"
          : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
        }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 text-sm truncate">
            {exam.name}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {examTypeLabel(t, exam.type)} · {exam.term} · {exam.academicYear}
          </p>
          {(exam.classNames || exam.className) && (
            <p className="text-xs text-primary-600 font-medium mt-1">
              {exam.classNames || exam.className}
            </p>
          )}
        </div>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full
          flex-shrink-0 ${meta.color} ${meta.bg}`}>
          {t(meta.labelKey)}
        </span>
      </div>
    </button>
  );
};

// ─────────────────
// MAIN PAGE
//
// PHASE 2: report HTML now comes from the shared backend renderer
// GET /results/:examId/student/:studentId/reportcard/html
// ─────────────────────────────────────────────────────────

export default function ReportCardsPage() {
  const { t, i18n } = useTranslation();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  const user     = useAuthStore((s) => s.user);

  const { data: examsData, isLoading: examsLoading } = useExams();

  const [selectedExam,    setSelectedExam]    = useState<Exam | null>(null);
  const [classes,         setClasses]         = useState<ClassOption[]>([]);
  const [selectedClass,   setSelectedClass]   = useState<ClassOption | null>(null);
  const [students,        setStudents]        = useState<StudentOption[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null);
  const [classLoading,    setClassLoading]    = useState(false);
  const [studentLoading,  setStudentLoading]  = useState(false);
  const [generating,      setGenerating]      = useState(false);
  const [reissuing,       setReissuing]       = useState(false);
  const [progress,        setProgress]        = useState({ done: 0, total: 0 });
  const [result,          setResult]          = useState<{
    success: number; error: number; message: string;
  } | null>(null);

  const exams = (examsData?.exams ?? []).filter(
    (e) => e.status === "completed" || e.status === "published"
  );

  // Load classes when exam selected
  useEffect(() => {
    if (!selectedExam) return;
    setClassLoading(true);
    setClasses([]);
    setSelectedClass(null);
    setStudents([]);
    api.get("/admin/classes", { params: { schoolId } })
      .then((res) => setClasses(
        res.data?.classes || (Array.isArray(res.data) ? res.data : [])
      ))
      .catch(() => setClasses([]))
      .finally(() => setClassLoading(false));
  }, [selectedExam, schoolId]);

  // Load students when class selected
  useEffect(() => {
    if (!selectedClass) return;
    setStudentLoading(true);
    setStudents([]);
    setSelectedStudent(null);
    api.get("/admin/students", {
      params: { schoolId, classId: selectedClass._id },
    })
      .then((res) => setStudents(
        res.data?.students || (Array.isArray(res.data) ? res.data : [])
      ))
      .catch(() => setStudents([]))
      .finally(() => setStudentLoading(false));
  }, [selectedClass, schoolId]);

  // ── Generate ────────────────────────────────────────────
  /**
   * Replace the frozen copy of an already-issued report card.
   *
   * Printing never overwrites an archived card, so a mark corrected after
   * issue would leave the parent's copy stale forever. Single student only —
   * replacing a document a parent already holds is a per-child decision, not
   * something to do to a whole class in one click.
   */
  const handleReissue = async () => {
    if (!selectedExam || !selectedStudent) return;

    const ok = window.confirm(
      `Reissue the report card for ${selectedStudent.studentName ?? "this student"}?

` +
      "This replaces the copy already issued to the parent with one built " +
      "from the current marks and template. The old copy is not kept."
    );
    if (!ok) return;

    setReissuing(true);
    setResult(null);
    try {
      const res = await api.post(
        `/results/${selectedExam._id}/student/${String(selectedStudent._id)}/reportcard/reissue`,
        { schoolId }
      );
      const revived = res.data?.data?.revived;
      setResult({
        success: 1,
        error:   0,
        message: revived
          ? "Report card restored and replaced with a fresh copy."
          : "Report card reissued — the parent's copy now reflects the current marks.",
      });
    } catch (err) {
      const data = (err as {
        response?: { data?: { error?: string; detail?: string } };
      })?.response?.data;
      setResult({
        success: 0,
        error:   1,
        message: data?.detail ?? data?.error ?? "Reissue failed.",
      });
    } finally {
      setReissuing(false);
    }
  };

  const handleGenerate = async () => {
    if (!selectedExam || !selectedClass) {
      alert("Please select an exam and a class");
      return;
    }

    const targetStudents = selectedStudent
      ? [selectedStudent]
      : students;

    if (targetStudents.length === 0) {
      alert("No students found in this class");
      return;
    }

    setGenerating(true);
    setResult(null);
    setProgress({ done: 0, total: targetStudents.length });

    let success = 0;
    let error   = 0;

    for (let i = 0; i < targetStudents.length; i++) {
      const student = targetStudents[i];
      try {
        // Phase 2: fetch pre-rendered HTML from the shared backend engine
        const sid    = String(student._id);
        const lang   = i18n?.resolvedLanguage ?? "en";
        const school = user?.schoolName || user?.school?.name || "";
        const res2   = await api.get(
          `/results/${selectedExam._id}/student/${sid}/reportcard/html`,
          { params: { schoolId, lang, schoolName: school } }
        );

        const body  = res2?.data;
        const html  = typeof res2 === "string"
          ? res2
          : body?.data?.html || body?.html || "";

        if (!html) {
          error++;
          continue;
        }

        // Open in new tab for printing
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(html);
          w.document.close();
          w.focus();
          setTimeout(() => {
            w.print();
          }, 500);
        }
        success++;
      } catch {
        error++;
      }
      setProgress({ done: i + 1, total: targetStudents.length });
    }

    setGenerating(false);
    setResult({
      success,
      error,
      message: `${success} report card(s) sent to print.${
        error > 0
          ? ` ${error} failed — no processed result found. Run Results → Compute for this exam first.`
          : ""
      }`,
    });
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("reportCards.title")}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {t("reportCards.blurb")}
          </p>
        </div>
        <Link
          to="/exams/results"
          className="px-4 py-2 bg-indigo-50 text-indigo-700 border
                     border-indigo-200 rounded-xl text-sm font-semibold
                     hover:bg-indigo-100 transition-colors"
        >
          📊 View Results
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">

        {/* Main form */}
        <div className="space-y-4">

          {/* Step 1: Exam */}
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                               flex items-center justify-center text-xs font-bold">
                1
              </span>
              {t("results.selectExam")}
            </h3>

            {examsLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-4 border-primary-600
                               border-t-transparent rounded-full animate-spin" />
              </div>
            ) : exams.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <p className="font-semibold">{t("reportCards.noneCompleted")}</p>
                <p className="text-sm mt-1">
                  {t("reportCards.completeFirst")}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3
                              max-h-60 overflow-y-auto pr-1">
                {exams.map((exam) => (
                  <ExamCard
                    key={exam._id}
                    exam={exam}
                    isSelected={selectedExam?._id === exam._id}
                    onSelect={() => {
                      setSelectedExam(exam);
                      setSelectedClass(null);
                      setSelectedStudent(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Step 2: Class */}
          {selectedExam && (
            <div className="bg-white rounded-xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                                 flex items-center justify-center text-xs font-bold">
                  2
                </span>
                {t("reportCards.selectClass")}
              </h3>

              {classLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="w-6 h-6 border-4 border-primary-600
                                 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {classes.map((cls) => (
                    <button
                      key={cls._id}
                      onClick={() => setSelectedClass(cls)}
                      className={`px-4 py-2 rounded-xl text-sm font-semibold
                        border transition-colors
                        ${selectedClass?._id === cls._id
                          ? "bg-primary-600 border-primary-600 text-white"
                          : "bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100"
                        }`}
                    >
                      {cls.name}
                    </button>
                  ))}
                  {classes.length === 0 && (
                    <p className="text-sm text-gray-400">{t("classes.none")}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Student (optional) */}
          {selectedClass && (
            <div className="bg-white rounded-xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
                <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                                 flex items-center justify-center text-xs font-bold">
                  3
                </span>
                {t("reportCards.selectStudent")}
                <span className="text-xs text-gray-400 font-normal">
                  (optional — leave empty for full class)
                </span>
              </h3>

              {studentLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="w-6 h-6 border-4 border-primary-600
                                 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    onClick={() => setSelectedStudent(null)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold
                      border transition-colors
                      ${!selectedStudent
                        ? "bg-primary-600 border-primary-600 text-white"
                        : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                      }`}
                  >
                    All {students.length} Students
                  </button>
                  {students.map((s) => {
                    const name = s.studentName || s.name || "Unknown";
                    return (
                      <button
                        key={s._id}
                        onClick={() => setSelectedStudent(s)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold
                          border transition-colors
                          ${selectedStudent?._id === s._id
                            ? "bg-primary-600 border-primary-600 text-white"
                            : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                          }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar — Generate panel */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-5 sticky top-6">
            <h3 className="font-semibold text-gray-900 mb-4">{t("common.generate")}</h3>

            {/* Summary */}
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t("academic.exam")}</span>
                <span className="font-semibold text-gray-900 truncate
                                 ml-2 max-w-[160px] text-right">
                  {selectedExam?.name || "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t("academic.class")}</span>
                <span className="font-semibold text-gray-900">
                  {selectedClass?.name || "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{t("academic.student")}</span>
                <span className="font-semibold text-gray-900">
                  {selectedStudent
                    ? selectedStudent.studentName || selectedStudent.name
                    : `All (${students.length})`}
                </span>
              </div>
            </div>

            {/* Progress */}
            {generating && (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Generating…</span>
                  <span>{progress.done} / {progress.total}</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary-500 rounded-full transition-all"
                    style={{
                      width: progress.total > 0
                        ? `${Math.round((progress.done / progress.total) * 100)}%`
                        : "0%",
                    }}
                  />
                </div>
              </div>
            )}

            {/* Result */}
            {result && !generating && (
              <div className={`rounded-xl p-3 mb-4 text-sm
                ${result.error > 0
                  ? "bg-amber-50 text-amber-700"
                  : "bg-green-50 text-green-700"
                }`}>
                {result.error > 0 ? "⚠️" : "✅"} {result.message}
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={!selectedExam || !selectedClass || generating}
              className="w-full py-3 bg-green-600 hover:bg-green-700
                         text-white rounded-xl font-semibold text-sm
                         transition-colors disabled:opacity-50
                         flex items-center justify-center gap-2"
            >
              {generating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white
                                 border-t-transparent rounded-full animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  🖨️{" "}
                  {selectedStudent
                    ? "Print Report Card"
                    : `Print All ${students.length || ""} Reports`}
                </>
              )}
            </button>

            {/* Reissue — only meaningful for one student at a time */}
            {selectedStudent && (
              <button
                onClick={handleReissue}
                disabled={reissuing || generating}
                className="w-full mt-2 py-2.5 border border-amber-300
                           hover:bg-amber-50 text-amber-800 rounded-xl
                           font-semibold text-sm transition-colors
                           disabled:opacity-50 flex items-center
                           justify-center gap-2"
              >
                {reissuing ? "Reissuing…" : "♻️ Reissue this card"}
              </button>
            )}

            <p className="text-xs text-gray-400 text-center mt-3">
              {t("reportCards.opensNewTab")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}