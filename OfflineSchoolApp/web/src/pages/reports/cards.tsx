// web/src/pages/reports/cards.tsx
import { useState, useEffect } from "react";
import { Link }                from "react-router-dom";
import { ArrowRight }          from "lucide-react";
import { useAuthStore }        from "@/store/auth.store";
import { useExams }            from "@/hooks/useExams";
import { EXAM_STATUS_META,
         examTypeLabel }    from "@/constants/exam.constants";
import type { Exam }           from "@/types/exam.types";

import api                     from "@/lib/axios";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface ClassOption   { _id: string; name: string }
interface StudentOption { _id: string; name: string; studentName?: string }

/**
 * Which of the three report cards to print.
 *
 * All three come from the same shared renderer and are chosen here rather than
 * on three pages, which is the same reason report cards live under Reports at
 * all: they used to appear in two places and read as two features.
 *
 * A sequence card is one exam's, so it is chosen by exam. A term card and an
 * annual card have no exam behind them — their marks are the sequences and the
 * terms combined — so they are chosen by the period they cover.
 */
type CardType = "sequence" | "term" | "annual";

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

  const [cardType,        setCardType]        = useState<CardType>("sequence");
  const [academicYear,    setAcademicYear]    = useState<string>("");
  const [termNumber,      setTermNumber]      = useState<string>("1");
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

  /**
   * The academic years to offer for a term or annual card.
   *
   * Read off the exams the school has actually run rather than generated from
   * today's date: a school printing last year's annual cards needs last year in
   * the list, and one that has not started this year does not need it yet.
   */
  const academicYears = [...new Set(
    (examsData?.exams ?? []).map((e) => e.academicYear).filter(Boolean)
  )].sort().reverse() as string[];

  useEffect(() => {
    if (!academicYear && academicYears.length) setAcademicYear(academicYears[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academicYears.join(",")]);

  /** Enough chosen to ask for the classes. */
  const periodChosen = cardType === "sequence"
    ? Boolean(selectedExam)
    : cardType === "term"
      ? Boolean(academicYear && termNumber)
      : Boolean(academicYear);

  /** What this card is of, for the messages and the confirm. */
  const typeLabel = t(`reportCards.type_${cardType}`);

  // Load classes when exam selected
  useEffect(() => {
    if (!periodChosen) return;
    setClassLoading(true);
    setClasses([]);
    setSelectedClass(null);
    setStudents([]);
    api.get("/admin/classes", { params: { schoolId } })
      .then((res) => {
        const all: ClassOption[] =
          res.data?.classes || (Array.isArray(res.data) ? res.data : []);

        /*
         * A sequence card can only be printed for a class the exam covers.
         *
         * This offered every class in the school, so picking one the exam does
         * not sit for produced a full roster of pupils with no marks — and
         * every print then failed with a message telling the reader to run
         * Compute, which could not have helped: there was nothing to compute,
         * because the exam was never written for that class. On the live school
         * both exams cover Form 1 and there are six other classes to choose
         * from, so this was five wrong choices out of six.
         *
         * A term or annual card is not filtered this way: its results are
         * computed per class and any class may legitimately have them.
         */
        const covered = cardType === "sequence" && selectedExam
          ? new Set([
              ...(selectedExam.classIds ?? []),
              ...(selectedExam.classId ? [selectedExam.classId] : []),
            ].map(String))
          : null;

        setClasses(
          covered && covered.size
            ? all.filter((c) => covered.has(String(c._id)))
            : all
        );
      })
      .catch(() => setClasses([]))
      .finally(() => setClassLoading(false));
  }, [periodChosen, cardType, selectedExam, academicYear, termNumber, schoolId]);

  /**
   * Load the pupils this card can be printed for.
   *
   * A sequence card comes from the class roster: the exam covers the class, and
   * a pupil with no marks prints an empty card, which is a legitimate thing to
   * hand a parent.
   *
   * A term or annual card cannot. Its marks are computed — the sequences
   * combined by weight, then the terms — and a pupil the computation has not
   * run for has no card to print, only a 404. So those two read the pupils out
   * of the computed results themselves, which is also what tells an admin that
   * Compute has not been run yet: the list comes back empty.
   */
  useEffect(() => {
    if (!selectedClass) return;
    setStudentLoading(true);
    setStudents([]);
    setSelectedStudent(null);

    const request = cardType === "sequence"
      ? api.get("/admin/students", {
          params: { schoolId, classId: selectedClass._id },
        }).then((res) =>
          res.data?.students || (Array.isArray(res.data) ? res.data : []))
      : api.get(cardType === "term" ? "/term-results" : "/annual-results", {
          params: {
            schoolId, academicYear, classId: selectedClass._id,
            ...(cardType === "term" ? { term: termNumber } : {}),
            limit: 200,
          },
        }).then((res) => (res.data?.results ?? []).map(
          (r: { studentId: string; studentName?: string }) => ({
            _id:         String(r.studentId),
            name:        r.studentName ?? "",
            studentName: r.studentName ?? "",
          })));

    request
      .then(setStudents)
      .catch(() => setStudents([]))
      .finally(() => setStudentLoading(false));
  }, [selectedClass, cardType, academicYear, termNumber, schoolId]);

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
      `${t("reportCards.reissueConfirm", {
        name: selectedStudent.studentName ?? t("reportCards.thisStudent"),
      })}

${t("reportCards.reissueBody")}`
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
          ? t("reportCards.reissueRevived")
          : t("reportCards.reissueDone"),
      });
    } catch (err) {
      const data = (err as {
        response?: { data?: { error?: string; detail?: string } };
      })?.response?.data;
      setResult({
        success: 0,
        error:   1,
        message: data?.detail ?? data?.error ?? t("reportCards.reissueFailed"),
      });
    } finally {
      setReissuing(false);
    }
  };

  /**
   * Where this card's HTML comes from.
   *
   * Three endpoints, one renderer behind all of them. The sequence one answers
   * JSON with the html inside; the term and annual ones answer the document
   * itself, because they were written for a browser to open directly.
   */
  const cardRequest = (sid: string) => {
    const lang   = i18n?.resolvedLanguage ?? "en";
    const school = user?.schoolName || user?.school?.name || "";
    if (cardType === "sequence") {
      return api.get(
        `/results/${selectedExam!._id}/student/${sid}/reportcard/html`,
        { params: { schoolId, lang, schoolName: school } }
      );
    }
    const base = cardType === "term" ? "/term-results" : "/annual-results";
    return api.get(`${base}/${sid}/report-card`, {
      params: {
        schoolId, academicYear, classId: selectedClass!._id, lang,
        ...(cardType === "term" ? { term: termNumber } : {}),
      },
    });
  };

  const handleGenerate = async () => {
    if (!periodChosen || !selectedClass) {
      alert(t("reportCards.chooseFirst"));
      return;
    }

    const targetStudents = selectedStudent
      ? [selectedStudent]
      : students;

    if (targetStudents.length === 0) {
      alert(t("reportCards.noStudents"));
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
        // One renderer, three endpoints — see cardRequest.
        const sid  = String(student._id);
        const res2 = await cardRequest(sid);

        // The term and annual routes send the document; the sequence route
        // wraps it in JSON. The old check here tested the axios RESPONSE for
        // being a string, which it never is, so the raw-HTML branch was dead.
        const body = res2?.data;
        const html = typeof body === "string"
          ? body
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
      // The remedy differs by card: a sequence card needs the exam's results
      // processed, a term or annual card needs Compute run for that period.
      message: `${t("reportCards.sentToPrint", { count: success })}${
        error > 0 ? ` ${t(`reportCards.someFailed_${cardType}`, { count: error })}` : ""
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
          📊 {t("reportCards.viewResults")}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">

        {/* Main form */}
        <div className="space-y-4">

          {/* Which of the three cards. Chosen first, because it decides what the
              next step even asks for: a sequence card is one exam's, a term or
              annual card covers a period and has no exam behind it. */}
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                               flex items-center justify-center text-xs font-bold">
                1
              </span>
              {t("reportCards.selectType")}
            </h3>
            <p className="text-xs text-gray-400 mb-3 ml-9">
              {t(`reportCards.typeHint_${cardType}`)}
            </p>
            <div className="flex flex-wrap gap-2">
              {(["sequence", "term", "annual"] as CardType[]).map((ct) => (
                <button
                  key={ct}
                  type="button"
                  onClick={() => {
                    setCardType(ct);
                    // The pickers below mean different things per type, so
                    // nothing chosen under one carries over to another.
                    setSelectedExam(null);
                    setSelectedClass(null);
                    setSelectedStudent(null);
                    setStudents([]);
                    setResult(null);
                  }}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border
                    transition-colors ${cardType === ct
                      ? "bg-primary-600 border-primary-600 text-white"
                      : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"}`}
                >
                  {t(`reportCards.type_${ct}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: the period this card covers */}
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                               flex items-center justify-center text-xs font-bold">
                2
              </span>
              {cardType === "sequence"
                ? t("results.selectExam")
                : t("reportCards.selectPeriod")}
            </h3>

            {cardType !== "sequence" && (
              <div className="flex flex-wrap gap-4 mb-2">
                <label className="block">
                  <span className="block text-xs font-semibold text-gray-500 mb-1.5">
                    {t("academic.schoolYear")}
                  </span>
                  <select
                    value={academicYear}
                    onChange={(e) => { setAcademicYear(e.target.value); setSelectedClass(null); }}
                    className="rounded-xl border border-gray-200 px-3 py-2 text-sm
                               outline-none focus:border-primary-400"
                  >
                    {academicYears.length === 0 && <option value="">—</option>}
                    {academicYears.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>

                {cardType === "term" && (
                  <label className="block">
                    <span className="block text-xs font-semibold text-gray-500 mb-1.5">
                      {t("academic.term")}
                    </span>
                    <div className="flex gap-2">
                      {["1", "2", "3"].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => { setTermNumber(n); setSelectedClass(null); }}
                          className={`px-3 py-2 rounded-xl text-sm font-semibold border
                            transition-colors ${termNumber === n
                              ? "bg-primary-600 border-primary-600 text-white"
                              : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"}`}
                        >
                          {t(`exams.term${n}`)}
                        </button>
                      ))}
                    </div>
                  </label>
                )}
              </div>
            )}

            {cardType !== "sequence" ? null : examsLoading ? (
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

          {/* Step 3: Class */}
          {periodChosen && (
            <div className="bg-white rounded-xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                                 flex items-center justify-center text-xs font-bold">
                  3
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

          {/* Step 4: Student (optional) */}
          {selectedClass && (
            <div className="bg-white rounded-xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
                <span className="w-7 h-7 bg-primary-600 text-white rounded-full
                                 flex items-center justify-center text-xs font-bold">
                  4
                </span>
                {t("reportCards.selectStudent")}
                <span className="text-xs text-gray-400 font-normal">
                  {t("reportCards.optionalWholeClass")}
                </span>
              </h3>

              {studentLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="w-6 h-6 border-4 border-primary-600
                                 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : students.length === 0 ? (
                /*
                 * The dead end this flow was famous for.
                 *
                 * A term or annual card is printed from computed results, so an
                 * empty list here does not mean the class is empty — it means
                 * step four was never run. The screen used to render a single
                 * "All 0 Students" button and leave the reader to work that out,
                 * which is the moment the whole flow felt broken rather than
                 * unfinished.
                 */
                <div className="mt-3 rounded-card border border-warning-line bg-warning-soft p-4">
                  <p className="text-sm font-semibold text-warning">
                    {cardType === "sequence"
                      ? t("reportCards.emptyRoster")
                      : t("reportCards.emptyComputed", { type: typeLabel })}
                  </p>
                  {cardType !== "sequence" && (
                    <Link
                      to={cardType === "term" ? "/exams/term-results" : "/exams/annual-results"}
                      className="mt-2 inline-flex items-center gap-1.5 text-sm
                                 font-semibold text-primary-700 hover:underline"
                    >
                      {t("reportCards.emptyComputeCta")}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  )}
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
                    {t("reportCards.allStudents", { count: students.length })}
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
              {/*
                * What this card is OF, which is an exam only for a sequence.
                *
                * This row read selectedExam whatever the card type, so a term
                * or annual card showed "—" against the word Exam: the one line
                * in the panel that should confirm what is about to be printed
                * said nothing had been chosen.
                */}
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">
                  {cardType === "sequence"
                    ? t("academic.exam")
                    : t("reportCards.selectPeriod")}
                </span>
                <span className="font-semibold text-gray-900 truncate
                                 ml-2 max-w-[160px] text-right">
                  {cardType === "sequence"
                    ? (selectedExam?.name || "—")
                    : cardType === "term"
                      ? (academicYear ? `${t(`exams.term${termNumber}`)} · ${academicYear}` : "—")
                      : (academicYear || "—")}
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
                  <span>{t("reportCards.generating")}</span>
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
              /*
               * periodChosen, not selectedExam.
               *
               * A term or annual card has no exam to select — its period is a
               * year and a term — so this gate was never satisfied and the
               * button stayed disabled for ever. The two card types could be
               * set up completely and still not be printable, with nothing on
               * screen to say what was missing.
               */
              disabled={!periodChosen || !selectedClass || generating}
              className="w-full py-3 bg-green-600 hover:bg-green-700
                         text-white rounded-xl font-semibold text-sm
                         transition-colors disabled:opacity-50
                         flex items-center justify-center gap-2"
            >
              {generating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white
                                 border-t-transparent rounded-full animate-spin" />
                  {t("reportCards.generating")}
                </>
              ) : (
                <>
                  🖨️{" "}
                  {selectedStudent
                    ? t("reportCards.printOne")
                    : t("reportCards.printAll", { count: students.length })}
                </>
              )}
            </button>

            {/* Reissue — one pupil at a time, and sequence cards only: the
                archive that gets replaced is keyed on an exam, and a term or
                annual card has no exam behind it. */}
            {selectedStudent && cardType === "sequence" && (
              <button
                onClick={handleReissue}
                disabled={reissuing || generating}
                className="w-full mt-2 py-2.5 border border-amber-300
                           hover:bg-amber-50 text-amber-800 rounded-xl
                           font-semibold text-sm transition-colors
                           disabled:opacity-50 flex items-center
                           justify-center gap-2"
              >
                {reissuing ? t("reportCards.reissuing") : `♻️ ${t("reportCards.reissue")}`}
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