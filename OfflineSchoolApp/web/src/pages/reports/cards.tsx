// web/src/pages/reports/cards.tsx
import { useState, useEffect, useRef } from "react";
import { Link }                from "react-router-dom";
import { ArrowRight, BarChart3, AlertTriangle, CheckCircle, Printer, RefreshCw } from "lucide-react";
import { useAuthStore }        from "@/store/auth.store";
import { useExams }            from "@/hooks/useExams";
import { EXAM_STATUS_META,
         examTypeLabel }    from "@/constants/exam.constants";
import type { Exam }           from "@/types/exam.types";

import api, { TIMEOUTS }       from "@/lib/axios";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";
import { ProgressBar }    from "@/components/ui/ProgressBar";
import { Modal }          from "@/components/ui/Modal";
import {
  openPreviewWindow,
  showInPreviewWindow,
  printHtml,
} from "@/print/document";
import { isDesktop }      from "@/lib/offline/bridge";

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

/** A fetched report card, held for the in-app batch preview. */
interface PreviewCard {
  id:   string;
  name: string;
  html: string;
  /** Issues the card once its print is requested; see issueCard. */
  issue: () => void;
}

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
            {examTypeLabel(t, exam.type)} · {t(`exams.term${exam.term}`, String(exam.term))} · {exam.academicYear}
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
  const { toast, confirm } = useToast();
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
  // `current` names the student in flight. A bar that only counts tells you
  // how long is left; one that names the row tells you what to look at when
  // a card comes out wrong.
  const [progress,        setProgress]        = useState({ done: 0, total: 0, current: "" });
  const [result,          setResult]          = useState<{
    success: number; error: number; message: string;
  } | null>(null);

  /*
   * Batch preview. A class is fetched one card at a time, then shown here —
   * no `window.open` per pupil, which browsers block after the first one.
   */
  const [previewCards,    setPreviewCards]    = useState<PreviewCard[]>([]);
  const [previewId,       setPreviewId]       = useState("");
  const [previewOpen,     setPreviewOpen]     = useState(false);
  const [previewMessage,  setPreviewMessage]  = useState("");

  /*
   * Bumped whenever a selection changes or a new generation starts. A request
   * whose token no longer matches is stale: it must not write progress, cards,
   * modal state or a result over the newer selection.
   */
  const generationRef = useRef(0);
  const printRunRef   = useRef(0);

  const invalidateGeneration = () => {
    generationRef.current += 1;
    // The stale run will return at its next check; the bar stops now rather
    // than waiting for a request nobody is waiting for any more.
    setGenerating(false);
  };

  const closePreview = () => {
    // Invalidate a print-status reply that is still in flight, and drop the
    // document so a closed modal does not keep the last card mounted.
    printRunRef.current += 1;
    setPreviewOpen(false);
    setPreviewMessage("");
    setPreviewCards([]);
    setPreviewId("");
  };

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

  // Defaulting the year once the list arrives. The !academicYear guard makes the
  // second run a no-op, so it converges rather than looping.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  /*
   * Load classes when the exam or period changes.
   *
   * Six dependencies, and changing card type moves several of them at once, so
   * two of these can easily be in flight together. The response was written
   * unconditionally, which meant the slower of two overlapping requests won —
   * and for a sequence card the filter below depends on `selectedExam`, so a
   * late response could apply the previous exam's coverage filter to the class
   * list the reader is looking at. `stale` drops anything that has been
   * superseded, and anything that arrives after the screen has gone.
   */
  useEffect(() => {
    if (!periodChosen) return;
    let stale = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClassLoading(true);
    setClasses([]);
    setSelectedClass(null);
    setStudents([]);
    api.get("/admin/classes", { params: { schoolId } })
      .then((res) => {
        if (stale) return;
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
      .catch(() => { if (!stale) setClasses([]); })
      .finally(() => { if (!stale) setClassLoading(false); });
    return () => { stale = true; };
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
    let stale = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    /*
     * Guarded for the same reason as the class list above, and it matters more
     * here: switching card type changes both the endpoint and the shape of what
     * comes back, so a late reply from the roster endpoint could land as the
     * pupil list for a term card — a list of every pupil in the class where the
     * empty list is the signal that Compute has not been run.
     */
    request
      .then((rows) => { if (!stale) setStudents(rows); })
      .catch(() => { if (!stale) setStudents([]); })
      .finally(() => { if (!stale) setStudentLoading(false); });
    return () => { stale = true; };
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

    const ok = await confirm({
      title:   t("reportCards.reissue"),
      message: `${t("reportCards.reissueConfirm", {
        name: selectedStudent.studentName ?? t("reportCards.thisStudent"),
      })}\n\n${t("reportCards.reissueBody")}`,
      kind:    "warning",
    });
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
        response?: { data?: { error?: string; detail?: string; code?: string } };
      })?.response?.data;
      setResult({
        success: 0,
        error:   1,
        message: data?.code === "NOT_ISSUED"
          ? t("reportCards.reissueNotIssued")
          : data?.detail ?? data?.error ?? t("reportCards.reissueFailed"),
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
   *
   * `issue` marks an actual print. Without it the card is fetched for the
   * preview only: the server neither archives it as the parent's copy nor
   * counts a print on its verification code.
   */
  const cardRequest = (sid: string, issue = false) => {
    const lang   = i18n?.resolvedLanguage ?? "en";
    const issued = issue ? { issue: 1 } : {};
    const school = user?.schoolName || user?.school?.name || "";
    if (cardType === "sequence") {
      return api.get(
        `/results/${selectedExam!._id}/student/${sid}/reportcard/html`,
        {
          params: { schoolId, lang, schoolName: school, ...issued },
          // One rendered card per request, and a class is generated one
          // pupil at a time — so this ceiling is reached per pupil, not
          // once. At 30s a slow render aborted mid-class and the run
          // reported failures for cards the server was still drawing.
          timeout: TIMEOUTS.render,
        }
      );
    }
    const base = cardType === "term" ? "/term-results" : "/annual-results";
    return api.get(`${base}/${sid}/report-card`, {
      params: {
        schoolId, academicYear, classId: selectedClass!._id, lang,
        ...(cardType === "term" ? { term: termNumber } : {}),
        ...issued,
      },
      timeout: TIMEOUTS.render,
    });
  };

  /**
   * Issue a card once its print has been requested: the server re-renders it,
   * archives a sequence card (the first issue wins) and counts the print. Bound
   * at fetch time, so a selection changed since still issues the card printed.
   * A failure here must not cost the reader the print they already have.
   */
  const issueCard = (sid: string) => () => {
    cardRequest(sid, true).catch(() => {});
  };

  const handleGenerate = async () => {
    if (!periodChosen || !selectedClass) {
      toast({ kind: "warning", title: t("reportCards.chooseFirst") });
      return;
    }

    const targetStudents = selectedStudent
      ? [selectedStudent]
      : students;

    if (targetStudents.length === 0) {
      toast({ kind: "warning", title: t("reportCards.noStudents") });
      return;
    }

    /*
     * Every generation carries a token. A selection change bumps the token,
     * so a reply that arrives afterwards knows it is answering a question the
     * reader has already moved on from.
     */
    const generation = ++generationRef.current;
    const isCurrent  = () => generationRef.current === generation;
    printRunRef.current += 1;

    /*
     * In a browser, one card is previewed in a tab. The tab is opened HERE,
     * synchronously, while the click still counts as a user gesture. Opening
     * it after the request below returns is what made the second and later
     * cards fail: a `window.open` outside the gesture is treated as an
     * unsolicited popup, returns null, and prints nothing — while the old code
     * counted it as a success. The window stays blank until the finished card
     * is written.
     *
     * The packaged desktop application denies every `window.open`
     * (desktop/src/main/main.js), so there a single card takes the same
     * in-app preview path as a class. No Electron policy is widened.
     */
    const single = targetStudents.length === 1;
    const singleInTab = single && !isDesktop();
    const previewWindow = singleInTab ? openPreviewWindow() : null;

    if (singleInTab && !previewWindow) {
      const message = t("reportCards.popupBlocked");
      setGenerating(false);
      setResult({ success: 0, error: 1, message });
      toast({ kind: "error", title: message });
      return;
    }

    setGenerating(true);
    setResult(null);
    setPreviewOpen(false);
    setPreviewCards([]);
    setPreviewId("");
    setPreviewMessage("");
    setProgress({ done: 0, total: targetStudents.length, current: "" });

    const collected: PreviewCard[] = [];
    let opened = 0;
    let error  = 0;
    let singleFailure: "empty" | "closed" | "show" | "request" | null = null;

    const discardPreviewWindow = () => {
      try {
        if (previewWindow && !previewWindow.closed) previewWindow.close();
      } catch {
        // Already gone; nothing to close.
      }
    };

    /* True when a selection or a newer run has superseded this one. */
    const stale = () => {
      if (isCurrent()) return false;
      discardPreviewWindow();
      return true;
    };

    /*
     * C2: a class is fetched four cards at a time. One at a time, a class of
     * forty waited out forty renders back to back; the server answers several
     * at once without trouble. Each card lands in its pupil's slot, so the
     * preview and the print keep the roster's order whatever finishes first.
     */
    if (!singleInTab) {
      const slots: (PreviewCard | null)[] = targetStudents.map(() => null);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < targetStudents.length && isCurrent()) {
          const i       = next++;
          const student = targetStudents[i];
          const name    = student.studentName || student.name || String(student._id);
          const sid     = String(student._id);
          try {
            const body = (await cardRequest(sid))?.data;
            const html = typeof body === "string" ? body : body?.data?.html || body?.html || "";
            if (html) slots[i] = { id: sid, name, html, issue: issueCard(sid) };
            else error++;
          } catch {
            error++;
          }
          done++;
          if (isCurrent()) setProgress({ done, total: targetStudents.length, current: name });
        }
      };
      setProgress({ done: 0, total: targetStudents.length, current: "" });
      await Promise.all(Array.from({ length: Math.min(4, targetStudents.length) }, worker));
      if (stale()) return;
      for (const card of slots) if (card) collected.push(card);
    }

    for (let i = 0; singleInTab && i < targetStudents.length; i++) {
      if (stale()) return;
      const student = targetStudents[i];
      const name    = student.studentName || student.name || String(student._id);
      setProgress({
        done:    i,
        total:   targetStudents.length,
        current: name,
      });
      try {
        // One renderer, three endpoints — see cardRequest.
        const sid  = String(student._id);
        const res2 = await cardRequest(sid);
        if (stale()) return;

        // The term and annual routes send the document; the sequence route
        // wraps it in JSON. The old check here tested the axios RESPONSE for
        // being a string, which it never is, so the raw-HTML branch was dead.
        const body = res2?.data;
        const html = typeof body === "string"
          ? body
          : body?.data?.html || body?.html || "";

        if (!html) {
          error++;
          if (singleInTab) { singleFailure = "empty"; discardPreviewWindow(); break; }
          continue;
        }

        if (singleInTab) {
          if (!previewWindow || previewWindow.closed) {
            error++;
            singleFailure = "closed";
            break;
          }
          if (!showInPreviewWindow(previewWindow, html, { onPrint: issueCard(sid) })) {
            error++;
            singleFailure = "show";
            discardPreviewWindow();
            break;
          }
          // The document was written. Printing was requested in that tab; it
          // is not claimed to have completed.
          opened++;
        } else {
          // A class — and any single card in the packaged desktop app — is
          // shown in the in-app preview. Opening one window per pupil is
          // exactly what browsers block after the first card.
          collected.push({ id: sid, name, html, issue: issueCard(sid) });
        }
      } catch {
        if (stale()) return;
        error++;
        if (singleInTab) { singleFailure = "request"; discardPreviewWindow(); break; }
      }
      if (stale()) return;
      setProgress({
        done:    i + 1,
        total:   targetStudents.length,
        current: name,
      });
    }

    if (stale()) return;
    setGenerating(false);

    if (singleInTab) {
      setResult({
        success: opened,
        error,
        message: opened
          ? t("reportCards.previewOpened")
          : singleFailure === "empty"
            ? t("reportCards.emptyResponse")
            : singleFailure === "closed"
              ? t("reportCards.previewClosed")
              : singleFailure === "show"
                ? t("reportCards.previewUnavailable")
                : t("reportCards.cardFailed"),
      });
      return;
    }

    if (collected.length === 0) {
      setResult({
        success: 0,
        error,
        // The remedy differs by card: a sequence card needs the exam's results
        // processed, a term or annual card needs Compute run for that period.
        message: `${t("reportCards.batchNone")}${
          error > 0 ? ` ${t(`reportCards.someFailed_${cardType}`, { count: error })}` : ""
        }`,
      });
      return;
    }

    setPreviewCards(collected);
    setPreviewId(collected[0].id);
    setPreviewOpen(true);
    setResult({
      success: collected.length,
      error,
      message: `${t("reportCards.batchReady", { count: collected.length })}${
        error > 0 ? ` ${t(`reportCards.someFailed_${cardType}`, { count: error })}` : ""
      }`,
    });
  };

  const previewCard = previewCards.find((card) => card.id === previewId)
    ?? previewCards[0]
    ?? null;

  /**
   * Print the card currently shown, through the same hidden-iframe helper the
   * rest of the console uses. "Requested", not "printed": the browser does not
   * tell the page whether the dialog was accepted.
   */
  const handlePrintPreview = async () => {
    if (!previewCard) return;
    const run = ++printRunRef.current;
    setPreviewMessage("");
    try {
      // Resolves once the iframe has reached print(); false when it could not.
      const requested = await printHtml(previewCard.html);
      if (requested) previewCard.issue();
      if (printRunRef.current !== run) return;
      setPreviewMessage(
        requested
          ? t("reportCards.printRequested", {
              name: previewCard.name || t("reportCards.thisStudent"),
            })
          : t("reportCards.printNotStarted")
      );
    } catch {
      if (printRunRef.current !== run) return;
      setPreviewMessage(t("reportCards.printNotStarted"));
    }
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
          <BarChart3 className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" aria-hidden />{t("reportCards.viewResults")}
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
                    invalidateGeneration();
                    setCardType(ct);
                    // The pickers below mean different things per type, so
                    // nothing chosen under one carries over to another.
                    setSelectedExam(null);
                    setSelectedClass(null);
                    setSelectedStudent(null);
                    setStudents([]);
                    setResult(null);
                    closePreview();
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
                    onChange={(e) => {
                      invalidateGeneration();
                      setAcademicYear(e.target.value);
                      setSelectedClass(null);
                    }}
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
                          onClick={() => {
                            invalidateGeneration();
                            setTermNumber(n);
                            setSelectedClass(null);
                          }}
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
                      invalidateGeneration();
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
                      onClick={() => {
                        invalidateGeneration();
                        setSelectedClass(cls);
                      }}
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
                    onClick={() => {
                      invalidateGeneration();
                      setSelectedStudent(null);
                    }}
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
                    const name = s.studentName || s.name || t("common.unknown");
                    return (
                      <button
                        key={s._id}
                        onClick={() => {
                          invalidateGeneration();
                          setSelectedStudent(s);
                        }}
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
              <ProgressBar
                className="mb-4"
                done={progress.done}
                total={progress.total}
                label={t("reportCards.generating")}
                detail={progress.current}
              />
            )}

            {/* Result */}
            {result && !generating && (
              <div className={`rounded-xl p-3 mb-4 text-sm
                ${result.error > 0
                  ? "bg-amber-50 text-amber-700"
                  : "bg-green-50 text-green-700"
                }`}>
                {result.error > 0 ? <AlertTriangle className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" aria-hidden /> : <CheckCircle className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" aria-hidden />}{result.message}
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
              className="w-full py-3 bg-primary-600 hover:bg-primary-700
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
                  <Printer className="w-4 h-4" aria-hidden />
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
                {reissuing ? t("reportCards.reissuing") : <><RefreshCw className="w-4 h-4" aria-hidden />{t("reportCards.reissue")}</>}
              </button>
            )}

            <p className="text-xs text-gray-400 text-center mt-3">
              {t("reportCards.previewNote")}
            </p>
          </div>
        </div>
      </div>

      {/*
        * A whole class, previewed here rather than in one pop-up per pupil.
        * The reader picks a card, checks it in the iframe and presses Print;
        * nothing is printed until they do.
        */}
      <Modal
        open={previewOpen}
        onClose={closePreview}
        title={t("reportCards.previewTitle")}
        size="lg"
        className="max-w-5xl"
      >
        <div className="space-y-3">
          {previewCards.length > 1 && (
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1.5">
                {t("reportCards.previewSelect")}
              </span>
              <select
                value={previewCard?.id ?? ""}
                onChange={(e) => {
                  printRunRef.current += 1;
                  setPreviewId(e.target.value);
                  setPreviewMessage("");
                }}
                className="w-full rounded-xl border border-gray-200 px-3 py-2
                           text-sm outline-none focus:border-primary-400"
              >
                {previewCards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.name || card.id}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="text-xs text-gray-500">{t("reportCards.previewHint")}</p>

          {previewCard ? (
            <iframe
              srcDoc={previewCard.html}
              className="h-[70vh] w-full rounded-lg border border-gray-200 bg-white"
              sandbox="allow-same-origin"
              title={t("reportCards.previewTitle")}
            />
          ) : (
            <p className="text-sm text-gray-500">{t("reportCards.batchNone")}</p>
          )}

          {previewMessage && (
            <p role="status" className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
              {previewMessage}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={closePreview}
              className="px-4 py-2 rounded-xl border border-gray-200 text-sm
                         font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {t("common.close")}
            </button>
            <button
              type="button"
              onClick={handlePrintPreview}
              disabled={!previewCard}
              className="px-4 py-2 rounded-xl bg-primary-600 hover:bg-primary-700
                         text-white text-sm font-semibold transition-colors
                         disabled:opacity-50"
            >
              {t("common.print")}
            </button>
          </div>
        </div>
      </Modal>

    </div>
  );
}