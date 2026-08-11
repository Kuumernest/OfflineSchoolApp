// web/src/pages/exams/reports/index.tsx
import { useState, useEffect } from "react";
import { Link }                from "react-router-dom";
import { useAuthStore }        from "@/store/auth.store";
import { useExams }            from "@/hooks/useExams";
import { EXAM_STATUS_META,
         EXAM_TYPE_LABELS }    from "@/constants/exam.constants";
import * as ExamService        from "@/services/exam.service";
import type { Exam }           from "@/types/exam.types";
import api                     from "@/lib/api";

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
            {EXAM_TYPE_LABELS[exam.type]} · {exam.term} · {exam.academicYear}
          </p>
          {(exam.classNames || exam.className) && (
            <p className="text-xs text-primary-600 font-medium mt-1">
              {exam.classNames || exam.className}
            </p>
          )}
        </div>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full
          flex-shrink-0 ${meta.color} ${meta.bg}`}>
          {meta.label}
        </span>
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────
// HTML REPORT BUILDER
// ─────────────────────────────────────────────────────────

function buildReportHtml(data: {
  studentName:      string;
  admissionNo:      string | null;
  className:        string;
  examName:         string;
  academicYear:     string;
  term:             string;
  percentage:       number;
  isPassing:        boolean;
  overallGrade:     string;
  subjectBreakdown: any[];
  schoolName:       string;
}) {
  const esc = (str: string) =>
    String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const rows = data.subjectBreakdown.map((s) => `
    <tr>
      <td>${esc(s.subjectName || "—")}</td>
      <td style="text-align:center">
        ${s.isAbsent ? "ABS" : s.score ?? "—"}
      </td>
      <td style="text-align:center">
        ${s.isAbsent ? "—" : s.normalizedMark?.toFixed(1) ?? "—"}
      </td>
      <td style="text-align:center;font-weight:bold;
                 color:${s.isPassing ? "#059669" : "#DC2626"}">
        ${s.isAbsent ? "ABS" : s.grade || "—"}
      </td>
      <td style="text-align:center;
                 color:${s.isPassing ? "#059669" : "#DC2626"}">
        ${s.isAbsent ? "—" : s.isPassing ? "Pass" : "Fail"}
      </td>
    </tr>
  `).join("");

  return `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Report Card — ${esc(data.studentName)}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, sans-serif; font-size: 12px;
             color: #111; padding: 24px; max-width: 800px; margin: 0 auto; }
      h1 { font-size: 20px; color: #1e40af; text-align: center; }
      .subtitle { text-align: center; color: #6b7280; margin-bottom: 20px; }
      .info-grid { display: grid; grid-template-columns: 1fr 1fr;
                   gap: 4px 24px; margin-bottom: 16px;
                   background: #f0f4ff; padding: 12px; border-radius: 8px; }
      .info-row  { display: flex; gap: 6px; font-size: 12px; }
      .lbl       { font-weight: bold; min-width: 110px; color: #374151; }
      .val       { color: #111; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      th, td { border: 1px solid #e5e7eb; padding: 6px 8px; }
      thead  { background: #2563EB; color: #fff; }
      tr:nth-child(even) { background: #f9fafb; }
      .result { text-align: center; padding: 12px; border-radius: 8px;
                font-weight: bold; font-size: 16px; margin-bottom: 16px; }
      .pass { background: #D1FAE5; color: #059669; }
      .fail { background: #FEE2E2; color: #DC2626; }
      .footer { text-align: center; font-size: 10px; color: #9ca3af;
                border-top: 1px solid #e5e7eb; padding-top: 10px; }
      @media print { body { padding: 12px; } }
    </style>
  </head><body>
    <h1>${esc(data.schoolName)}</h1>
    <p class="subtitle">Academic Report Card</p>

    <div class="info-grid">
      <div class="info-row">
        <span class="lbl">Student:</span>
        <span class="val">${esc(data.studentName)}</span>
      </div>
      <div class="info-row">
        <span class="lbl">Admission No:</span>
        <span class="val">${data.admissionNo ? `#${esc(data.admissionNo)}` : "—"}</span>
      </div>
      <div class="info-row">
        <span class="lbl">Class:</span>
        <span class="val">${esc(data.className)}</span>
      </div>
      <div class="info-row">
        <span class="lbl">Exam:</span>
        <span class="val">${esc(data.examName)}</span>
      </div>
      <div class="info-row">
        <span class="lbl">Academic Year:</span>
        <span class="val">${esc(data.academicYear)}</span>
      </div>
      <div class="info-row">
        <span class="lbl">Term:</span>
        <span class="val">${esc(data.term)}</span>
      </div>
    </div>

    ${rows.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th style="text-align:center">Score</th>
          <th style="text-align:center">/20</th>
          <th style="text-align:center">Grade</th>
          <th style="text-align:center">Result</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>` : "<p style='color:#9ca3af;margin:16px 0'>No subject scores found.</p>"}

    <div class="result ${data.isPassing ? "pass" : "fail"}">
      ${data.isPassing ? "✓ PASS" : "✗ FAIL"} —
      ${data.percentage.toFixed(1)}% — Grade: ${esc(data.overallGrade)}
    </div>

    <div class="footer">
      Generated on ${new Date().toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric",
      })} | ${esc(data.schoolName)}
    </div>
  </body></html>`;
}

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function ExamReportsPage() {
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
        const sid = String(student._id);
        const res = await api.get(
          `/results/${selectedExam._id}/student/${sid}`,
          { params: { schoolId } }
        ).catch(() => null);

        const data = res?.data?.data?.summary || res?.data?.data || null;

        const html = buildReportHtml({
          studentName:      data?.studentName  || student.studentName || student.name || "Unknown",
          admissionNo:      data?.admissionNo  || null,
          className:        data?.className    || selectedClass.name,
          examName:         selectedExam.name,
          academicYear:     selectedExam.academicYear,
          term:             selectedExam.term,
          percentage:       data?.percentage   ?? 0,
          isPassing:        data?.isPassing    ?? false,
          overallGrade:     data?.overallGrade || "—",
          subjectBreakdown: data?.subjectBreakdown || [],
          schoolName:       (user as any)?.schoolName ||
                            (user as any)?.school?.name ||
                            "School",
        });

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
        error > 0 ? ` ${error} failed.` : ""
      }`,
    });
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Report Cards</h1>
          <p className="text-gray-500 text-sm mt-1">
            Generate and print student report cards
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
              Select Exam
            </h3>

            {examsLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-4 border-primary-600
                               border-t-transparent rounded-full animate-spin" />
              </div>
            ) : exams.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <p className="font-semibold">No completed exams yet</p>
                <p className="text-sm mt-1">
                  Complete an exam first to generate report cards
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
                Select Class
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
                    <p className="text-sm text-gray-400">No classes found</p>
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
                Select Student
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
            <h3 className="font-semibold text-gray-900 mb-4">Generate</h3>

            {/* Summary */}
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Exam</span>
                <span className="font-semibold text-gray-900 truncate
                                 ml-2 max-w-[160px] text-right">
                  {selectedExam?.name || "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Class</span>
                <span className="font-semibold text-gray-900">
                  {selectedClass?.name || "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Student</span>
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

            <p className="text-xs text-gray-400 text-center mt-3">
              Reports open in new tabs for printing
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}