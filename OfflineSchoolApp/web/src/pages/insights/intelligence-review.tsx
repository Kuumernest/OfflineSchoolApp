// web/src/pages/insights/intelligence-review.tsx
//
// A teacher judges what the engine said about a pupil they teach.
//
//   open the queue → pick a case → read the EVIDENCE → read what the ENGINE
//   made of it → say what YOU make of it → submit → now see what colleagues said
//
// ── Three things, kept apart on the screen ──────────────────────────────────
//
// Every case is laid out in the same three sections, in the same order:
//
//   1. Observed evidence      the marks, and the numbers computed from them
//   2. System interpretation  the codes, the guidance, the thresholds behind them
//   3. Your review            the structured form, and nothing the engine wrote
//
// A reviewer who cannot tell the marks from the engine's reading of them cannot
// disagree with the engine, and disagreement is the whole point.
//
// ── Independence ─────────────────────────────────────────────────────────────
//
// The server decides what this viewer may see of other reviewers. A teacher who
// has not yet answered a case gets a count — "two colleagues have reviewed
// this" — and no content and no names. After they submit, the others appear.
// This page never has the hidden answers to leak; it renders what it was sent.
//
// ── Where the thinking happens ───────────────────────────────────────────────
//
// On the server. The allowed values for every form field come down with the
// sheet (reviewForm) and are validated again on submit; the case is verified
// against the engine before a review is stored; the queue order is the
// server's. This file holds no threshold, no rule and no copy of the form
// contract.
//
// ── Wording ──────────────────────────────────────────────────────────────────
//
// Codes in, sentences out of the i18n catalogue, in English or French. Nothing
// on this page is called accuracy, a score or a grade for the engine: two
// teachers agreeing that the engine was wrong is agreement, and it is shown as
// exactly that.

import { useMemo, useState }                       from "react";
import { useQuery, useMutation, useQueryClient }   from "@tanstack/react-query";
import { useTranslation }                          from "react-i18next";
import { ClipboardCheck, EyeOff, Users, ChevronRight, Info, FlaskConical } from "lucide-react";

import { useUser }      from "@/store/auth.store";
import { PageHeader }   from "@/components/ui/PageHeader";
import { Card }         from "@/components/ui/Card";
import { Select }       from "@/components/ui/Select";
import { Button }       from "@/components/ui/Button";
import { Badge }        from "@/components/ui/Badge";
import { Modal }        from "@/components/ui/Modal";
import { PageSpinner }  from "@/components/ui/Spinner";
import { useToast }     from "@/components/ui/Toast";
import { FormField, Textarea, SelectField, Checkbox } from "@/components/ui/FormField";
import api              from "@/services/api";
import {
  fetchReviewCases, submitReview, reviseReview, fetchPlatformCalibration,
  fetchPilot, fetchPilotEvidence, openPilot, advancePilot, fetchConsistency, fetchPreflight, addFinding, updateFinding, fetchExplorationSummary, fetchPilotReport,
  ENGINE_KEYS, ATTESTATION_KEYS,
  type ReviewCase, type ReviewForm, type ReviewFormContract, type ReviewPackage,
  type RecordedReview, type ReviewStatus,
  type Pilot, type LeanPilot, type PilotKind, type PilotStatus, type PilotOutcome, type PilotEvidence, type PilotFinding, type PilotReport, type Preflight,
  type EngineVersions, type Attestations, type AttestationKey, type ReadinessStatus,
  type ConcernGroup, type FindingCategory, type FindingSeverity, type FindingStatus, type FindingSource,
} from "@/services/insights.service";

const STATUS_VARIANT: Record<ReviewStatus, "default" | "info" | "success"> = {
  UNREVIEWED:       "default",
  ONE_REVIEW:       "info",
  MULTIPLE_REVIEWS: "success",
};

/** The metrics the engine computed, in the order a teacher reads them. */
const METRIC_LABELS: Array<[keyof NonNullable<ReviewCase["metrics"]>, string]> = [
  ["recentAverage",  "evidence.recent_average"],
  ["priorAverage",   "evidence.previous_average"],
  ["overallAverage", "evidence.overall_average"],
  ["delta",          "evidence.change"],
  ["latestStep",     "evidence.latest_change"],
  ["spread",         "evidence.spread"],
  ["consistency",    "evidence.consistency"],
  ["belowPass",      "evidence.marks_below_pass"],
  ["strongMarks",    "evidence.marks_at_or_above_threshold"],
];

type Filter = "all" | "mine_pending" | "mine_done" | "unreviewed";

async function fetchMyClasses(): Promise<Array<{ _id: string; name: string }>> {
  const { data } = await api.get("/teacher/my-classes");
  return ((data as { classes?: Array<{ _id: string; name: string }> }).classes ?? []);
}

const emptyForm = (contract: ReviewFormContract, c: ReviewCase): ReviewForm => ({
  observedPattern: null, classificationAppropriate: null, evidenceSufficient: null,
  guidanceAppropriate: null, reason: null, notes: null, dataQuality: [],
  ...(c.classifications.some((k) => contract.temporal.appliesTo.includes(k.code))
    ? { temporal: { interpretationReasonable: null, possibleExplanation: null } } : {}),
});

export default function IntelligenceReviewPage() {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();
  const user      = useUser();

  const isOperator = user?.role === "super_admin";
  const isAdmin    = isOperator || user?.role === "school_admin";
  // The operator reviews the school they have selected; the id is mirrored
  // into user.schoolId by the auth store. No selection is no school, not all.
  const schoolId   = isOperator ? (user?.schoolId || "") : undefined;
  const blocked    = isOperator && !schoolId;

  const [classId, setClassId] = useState("");
  const [filter,  setFilter]  = useState<Filter>("all");
  const [openId,  setOpenId]  = useState<string | null>(null);

  const classesQ = useQuery({ queryKey: ["my-classes"], queryFn: fetchMyClasses, enabled: !blocked });
  const sheetQ = useQuery({
    queryKey: ["review-cases", schoolId ?? "own", classId],
    queryFn:  () => fetchReviewCases({ ...(schoolId ? { schoolId } : {}), ...(classId ? { classId } : {}) }),
    enabled:  !blocked,
    staleTime: 30_000,
  });

  const pilotQ = useQuery({
    queryKey: ["pilot", schoolId ?? "own"],
    queryFn:  () => fetchPilot(schoolId),
    enabled:  !blocked,
    staleTime: 30_000,
  });

  const sheet = sheetQ.data;
  const cases = useMemo(() => {
    const all = sheet?.cases ?? [];
    switch (filter) {
      case "unreviewed":   return all.filter((c) => c.reviewCount === 0);
      case "mine_pending": return all.filter((c) => !c.myReview);
      case "mine_done":    return all.filter((c) => !!c.myReview);
      default:             return all;
    }
  }, [sheet, filter]);
  const open = sheet?.cases.find((c) => c.caseId === openId) ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["review-cases"] });

  if (blocked) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("intelReview.title")} description={t("intelReview.blurb")} />
        <Card><p className="text-sm text-ink-muted">{t("intelReview.selectSchool")}</p></Card>
      </div>
    );
  }

  const classes = classesQ.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title={t("intelReview.title")} description={t("intelReview.blurb")} />

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row">
            {classes.length > 0 && (
              <div className="w-full sm:w-56">
                <label className="mb-1 block text-xs font-medium text-ink-faint" htmlFor="review-class">
                  {t("intelReview.class")}
                </label>
                <Select
                  id="review-class" className="w-full" value={classId}
                  onChange={(e) => setClassId(e.target.value)}
                  options={[{ value: "", label: t(isAdmin ? "intelReview.wholeSchool" : "intelReview.allMyClasses") },
                            ...classes.map((c) => ({ value: c._id, label: c.name }))]}
                />
              </div>
            )}
            <div className="w-full sm:w-56">
              <label className="mb-1 block text-xs font-medium text-ink-faint" htmlFor="review-filter">
                {t("intelReview.show")}
              </label>
              <Select
                id="review-filter" className="w-full" value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                options={(["all", "mine_pending", "mine_done", "unreviewed"] as Filter[])
                  .map((f) => ({ value: f, label: t(`intelReview.filter.${f}`) }))}
              />
            </div>
          </div>
          {sheet && (
            <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
              <Badge variant="default" label={t("intelReview.engine", { v: sheet.engineVersion })} />
              <Badge variant="default" label={t("intelReview.status.UNREVIEWED_n", { n: sheet.reviewStatus.unreviewed })} />
              <Badge variant="info"    label={t("intelReview.status.ONE_REVIEW_n", { n: sheet.reviewStatus.oneReview })} />
              <Badge variant="success" label={t("intelReview.status.MULTIPLE_REVIEWS_n", { n: sheet.reviewStatus.multipleReviews })} />
            </div>
          )}
        </div>
      </Card>

      {sheetQ.isError && (
        <Card className="ring-warning-line">
          <p className="text-sm text-warning">{t("intelReview.stale")}</p>
        </Card>
      )}
      {sheetQ.isLoading && <PageSpinner />}

      {/* The briefing comes before the queue, every time — what the system is,
          what it is not, and that disagreement is the point. */}
      <Briefing />
      {!isAdmin && pilotQ.data?.open && pilotQ.data.pilot && <PilotBanner pilot={pilotQ.data.pilot} />}

      {isAdmin && (
        <PilotPanel
          pilot={(pilotQ.data?.pilot as Pilot | null) ?? null}
          open={Boolean(pilotQ.data?.open)}
          classes={classes}
          schoolId={schoolId}
          toast={toast}
          onChanged={async () => { await qc.invalidateQueries({ queryKey: ["pilot"] }); }}
        />
      )}
      {isAdmin && sheet && <Monitoring sheet={sheet} />}
      {isAdmin && <ExplorationAcrossSchool schoolId={schoolId} classId={classId} />}
      {isOperator && <AcrossSchools />}

      {sheet && !cases.length && (
        <Card><p className="text-sm text-ink-muted">{t("intelReview.empty")}</p></Card>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cases.map((c) => <CaseCard key={c.caseId} c={c} onOpen={() => setOpenId(c.caseId)} />)}
      </div>

      {open && sheet && (
        <CasePanel
          c={open} contract={sheet.reviewForm} engineVersion={sheet.engineVersion}
          schoolId={schoolId} onClose={() => setOpenId(null)}
          onChanged={async () => { await refresh(); }} toast={toast}
        />
      )}
    </div>
  );
}

/** One case in the queue: who, what, and how far the review has got. */
function CaseCard({ c, onOpen }: { c: ReviewCase; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            {c.studentName ?? c.studentId}
            {c.subjectName && <span className="font-normal text-ink-muted"> · {c.subjectName}</span>}
          </p>
          <p className="text-xs text-ink-muted">
            {c.className ?? ""}{c.enrollmentNo ? ` · ${c.enrollmentNo}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          {t(c.myReview ? "intelReview.revise" : "intelReview.review")} <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-sm text-ink">{t(`intelReview.category.${c.category}`, { defaultValue: c.category })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[c.reviewStatus]} label={t(`intelReview.status.${c.reviewStatus}`)} />
        {c.myReview && <Badge variant="success" label={t("intelReview.youReviewed")} />}
        {c.othersHidden && (
          <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
            <EyeOff className="h-3.5 w-3.5" /> {t("intelReview.hiddenUntilYours", { n: c.reviewCount })}
          </span>
        )}
        {c.agreement && (
          <Badge variant={c.agreement === "AGREE" ? "success" : "warning"} label={t(`intelReview.agreement.${c.agreement}`)} />
        )}
      </div>
    </Card>
  );
}

/**
 * One case, in three sections, then the form, then — if this viewer may see
 * them — what the other reviewers said.
 */
function CasePanel({
  c, contract, engineVersion, schoolId, onClose, onChanged, toast,
}: {
  c: ReviewCase; contract: ReviewFormContract; engineVersion: string; schoolId?: string;
  onClose: () => void; onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ReviewForm>(() =>
    c.myReview ? { ...emptyForm(contract, c), ...c.myReview.review } : emptyForm(contract, c));

  const set = <K extends keyof ReviewForm>(k: K, v: ReviewForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setTemporal = (k: "interpretationReasonable" | "possibleExplanation", v: string | null) =>
    setForm((f) => ({ ...f, temporal: { interpretationReasonable: null, possibleExplanation: null, ...f.temporal, [k]: v } }));
  const toggleQuality = (code: string, on: boolean) =>
    set("dataQuality", on ? [...new Set([...form.dataQuality, code])] : form.dataQuality.filter((x) => x !== code));

  const save = useMutation({
    mutationFn: () => c.myReview
      ? reviseReview(c.myReview.reviewId, { ...(schoolId ? { schoolId } : {}), version: c.myReview.version, review: form })
      : submitReview({ ...(schoolId ? { schoolId } : {}), studentId: c.studentId, subjectId: c.subjectId,
                       category: c.category, engineVersion, review: form }),
    onSuccess: async () => {
      toast({ kind: "success", title: t(c.myReview ? "intelReview.revised" : "intelReview.submitted") });
      await onChanged();
    },
    onError: (err: unknown) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast({ kind: code === "STALE_ENGINE_VERSION" || code === "VERSION_CONFLICT" ? "warning" : "error",
              title: t(`intelReview.error.${code ?? "generic"}`, { defaultValue: t("intelReview.error.generic") }) });
    },
  });

  const complete = !!form.observedPattern && !!form.classificationAppropriate
    && !!form.evidenceSufficient && !!form.guidanceAppropriate;
  const others = c.reviews.filter((r) => r.reviewId !== c.myReview?.reviewId);
  const answers = (values: string[]) =>
    [{ value: "", label: t("intelReview.answer.choose") }, ...values.map((v) => ({ value: v, label: t(`intelReview.answer.${v}`) }))];

  return (
    <Modal open onClose={onClose} size="lg"
           title={`${c.studentName ?? c.studentId}${c.subjectName ? ` · ${c.subjectName}` : ""}`}>
      <div className="max-h-[75vh] space-y-6 overflow-y-auto pr-1">

        <p className="text-sm text-ink-muted">
          {t(`intelReview.category.${c.category}`, { defaultValue: c.category })} — {t(`intelReview.reason.${c.category}`, { defaultValue: c.selectedBecause })}
        </p>

        {/* ── 1. Observed evidence ─────────────────────────────────────── */}
        <Section heading={t("intelReview.evidenceHeading")} hint={t("intelReview.evidenceHint")}>
          {c.marks.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              {c.marks.map((m) => <li key={m} className="font-mono text-ink">{m}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">{t("intelReview.studentScoped", { n: c.observations })}</p>
          )}
          {c.metrics && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {METRIC_LABELS.map(([k, label]) => c.metrics![k] !== null && c.metrics![k] !== undefined && (
                <div key={k} className="flex justify-between gap-2 border-b border-line py-1">
                  <dt className="text-ink-muted">{t(label)}</dt>
                  <dd className="font-medium text-ink">
                    {k === "consistency" ? t(`intelReview.consistency.${String(c.metrics![k])}`, { defaultValue: String(c.metrics![k]) }) : String(c.metrics![k])}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>

        {/* ── 2. System interpretation ─────────────────────────────────── */}
        <Section heading={t("intelReview.engineHeading")} hint={t("intelReview.engineHint", { v: engineVersion })}>
          {c.classifications.length === 0 && <p className="text-sm text-ink-muted">{t("intelReview.noClassification")}</p>}
          <ul className="space-y-2">
            {c.classifications.map((k) => (
              <li key={k.code} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">{t(`intelReview.code.${k.code}`, { defaultValue: k.code })}</span>
                <Badge variant="default" label={t(`confidence.${k.confidence}`, { defaultValue: k.confidence })} />
              </li>
            ))}
          </ul>
          {c.guidance.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-ink-faint">{t("intelReview.guidanceGiven")}</p>
              <ul className="mt-1 space-y-1 text-sm text-ink">
                {c.guidance.map((g, i) => (
                  <li key={i}>{t(`guidance.${g.rationaleCode}`, { defaultValue: g.rationaleCode })}</li>
                ))}
              </ul>
            </div>
          )}
          {c.thresholdsInvolved.length > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              {t("intelReview.thresholds")}: {c.thresholdsInvolved.map((x) => `${x.threshold} = ${x.value}`).join(", ")}
            </p>
          )}
          <ConsistencyCheck studentId={c.studentId} schoolId={schoolId} />
        </Section>

        {/* ── 3. Your review ───────────────────────────────────────────── */}
        <Section heading={t("intelReview.yourHeading")} hint={t("intelReview.yourHint")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t("intelReview.field.observedPattern")} required>
              <SelectField options={answers(contract.observedPattern)} value={form.observedPattern ?? ""}
                           onChange={(e) => set("observedPattern", e.target.value || null)} />
            </FormField>
            <FormField label={t("intelReview.field.classificationAppropriate")} required>
              <SelectField options={answers(contract.classificationAppropriate)} value={form.classificationAppropriate ?? ""}
                           onChange={(e) => set("classificationAppropriate", e.target.value || null)} />
            </FormField>
            <FormField label={t("intelReview.field.evidenceSufficient")} required>
              <SelectField options={answers(contract.evidenceSufficient)} value={form.evidenceSufficient ?? ""}
                           onChange={(e) => set("evidenceSufficient", e.target.value || null)} />
            </FormField>
            <FormField label={t("intelReview.field.guidanceAppropriate")} required>
              <SelectField options={answers(contract.guidanceAppropriate)} value={form.guidanceAppropriate ?? ""}
                           onChange={(e) => set("guidanceAppropriate", e.target.value || null)} />
            </FormField>
            {form.temporal && (
              <>
                <FormField label={t("intelReview.field.interpretationReasonable")}>
                  <SelectField options={answers(contract.temporal.interpretationReasonable)}
                               value={form.temporal.interpretationReasonable ?? ""}
                               onChange={(e) => setTemporal("interpretationReasonable", e.target.value || null)} />
                </FormField>
                <FormField label={t("intelReview.field.possibleExplanation")}>
                  <SelectField
                    options={[{ value: "", label: t("intelReview.answer.choose") },
                              ...contract.temporal.possibleExplanation.map((v) => ({ value: v, label: t(`intelReview.explanation.${v}`, { defaultValue: v }) }))]}
                    value={form.temporal.possibleExplanation ?? ""}
                    onChange={(e) => setTemporal("possibleExplanation", e.target.value || null)} />
                </FormField>
              </>
            )}
          </div>

          <FormField label={t("intelReview.field.dataQuality")} hint={t("intelReview.dataQualityHint")} className="mt-3">
            <div className="grid gap-1 sm:grid-cols-2">
              {contract.dataQuality.map((code) => (
                <Checkbox key={code} label={t(`intelReview.dataQuality.${code}`, { defaultValue: code })}
                          checked={form.dataQuality.includes(code)}
                          onChange={(e) => toggleQuality(code, e.target.checked)} />
              ))}
            </div>
          </FormField>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <FormField label={t("intelReview.field.reason")}>
              <Textarea rows={3} value={form.reason ?? ""} maxLength={2000}
                        onChange={(e) => set("reason", e.target.value || null)} />
            </FormField>
            <FormField label={t("intelReview.field.notes")}>
              <Textarea rows={3} value={form.notes ?? ""} maxLength={4000}
                        onChange={(e) => set("notes", e.target.value || null)} />
            </FormField>
          </div>

          {c.myReview && (
            <p className="mt-2 text-xs text-ink-muted">
              {t("intelReview.yoursOn", { when: new Date(c.myReview.reviewedAt).toLocaleString(), v: c.myReview.engineVersion })}
              {c.myReview.revisedAt && ` · ${t("intelReview.revisedOn", { when: new Date(c.myReview.revisedAt).toLocaleString() })}`}
            </p>
          )}
        </Section>

        {/* ── Other reviewers ──────────────────────────────────────────── */}
        <Section heading={t("intelReview.othersHeading")}>
          {c.othersHidden && (
            <p className="inline-flex items-center gap-2 text-sm text-ink-muted">
              <EyeOff className="h-4 w-4" /> {t("intelReview.hiddenUntilYours", { n: c.reviewCount })}
            </p>
          )}
          {!c.othersHidden && others.length === 0 && (
            <p className="text-sm text-ink-muted">{t("intelReview.noOthers")}</p>
          )}
          {others.map((r) => <OtherReview key={r.reviewId} r={r} />)}
          {c.agreement && (
            <p className="mt-2 text-xs text-ink-muted">{t(`intelReview.agreementNote.${c.agreement}`)}</p>
          )}
        </Section>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
        <Button variant="primary" disabled={!complete || save.isPending} onClick={() => save.mutate()}>
          {t(c.myReview ? "intelReview.saveRevision" : "intelReview.submit")}
        </Button>
      </div>
    </Modal>
  );
}

function OtherReview({ r }: { r: RecordedReview }) {
  const { t } = useTranslation();
  const f = r.review;
  return (
    <div className="rounded-md border border-line p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Users className="h-4 w-4 text-ink-faint" /> {r.reviewedByName ?? r.reviewedBy}
        <span className="text-xs font-normal text-ink-muted">{new Date(r.reviewedAt).toLocaleDateString()} · v{r.engineVersion}</span>
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        {(["observedPattern", "classificationAppropriate", "evidenceSufficient", "guidanceAppropriate"] as const).map((k) => (
          <div key={k}>
            <dt className="text-ink-muted">{t(`intelReview.field.${k}`)}</dt>
            <dd className="font-medium text-ink">{f[k] ? t(`intelReview.answer.${f[k]}`) : "—"}</dd>
          </div>
        ))}
      </dl>
      {f.dataQuality?.length > 0 && (
        <p className="mt-2 text-xs text-ink-muted">
          {t("intelReview.field.dataQuality")}: {f.dataQuality.map((d) => t(`intelReview.dataQuality.${d}`, { defaultValue: d })).join(", ")}
        </p>
      )}
      {f.reason && <p className="mt-2 text-sm text-ink">{f.reason}</p>}
    </div>
  );
}

/** The head's view of how the validation is going across the scope. Counts only. */
function Monitoring({ sheet }: { sheet: ReviewPackage }) {
  const { t } = useTranslation();
  const s = sheet.reviewStatus;
  const fb = sheet.feedback;
  return (
    <Card className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">{t("intelReview.monitoring")}</h3>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="default" label={t("intelReview.mon.cases", { n: s.cases })} />
        <Badge variant="default" label={t("intelReview.mon.reviewsRecorded", { n: s.reviewsRecorded })} />
        <Badge variant="default" label={t("intelReview.mon.reviewers", { n: s.reviewers })} />
        <Badge variant="success" label={t("intelReview.mon.agree", { n: s.agreement.agree })} />
        <Badge variant="warning" label={t("intelReview.mon.differ", { n: s.agreement.differ })} />
      </div>
      {s.repeatedDisagreements.length > 0 && (
        <p className="text-xs text-ink-muted">
          {t("intelReview.repeatedDisagreements")}: {s.repeatedDisagreements.map((k) => t(`intelReview.category.${k}`, { defaultValue: k })).join(", ")}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink-faint">{t("intelReview.mon.byCategory")}</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {Object.entries(s.byCategory).map(([k, v]) => (
              <li key={k} className="flex justify-between gap-2">
                <span className="text-ink">{t(`intelReview.category.${k}`, { defaultValue: k })}</span>
                <span className="text-ink-muted">{t("intelReview.mon.catCounts", { r: v.reviewed, c: v.cases, m: v.multipleReviews })}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-ink-faint">{t("intelReview.mon.byOutcome")}</p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {Object.entries(fb.totals.byOutcome).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-ink">{t(`intelReview.outcome.${k}`, { defaultValue: k })}</span>
                  <span className="text-ink-muted">{v}</span>
                </li>
              ))}
            </ul>
            {fb.sharesWithheld && <p className="mt-1 text-xs text-ink-muted">{t("intelReview.mon.sharesWithheld")}</p>}
          </div>
          {fb.concerns && (
            <div>
              <p className="text-xs font-medium text-ink-faint">{t("intelReview.concern.heading")}</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {(["interpretationDisagreement", "dataQuality", "missingEvidence", "contextualLimitation"] as ConcernGroup[]).map((g) => (
                  <li key={g} className="flex justify-between gap-2">
                    <span className="text-ink">{t(`intelReview.concern.${g}`)}</span>
                    <span className="text-ink-muted">
                      {fb.concerns[g].reviews}
                      {fb.concerns[g].repeated.length > 0 && ` · ${t("intelReview.concern.repeated")}: ${fb.concerns[g].repeated.map((r) => `${t(`intelReview.dataQuality.${r.code}`, { defaultValue: t(`intelReview.code.${r.code}`, { defaultValue: r.code }) })} (${r.support})`).join(", ")}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-ink-muted">{t("intelReview.concern.note")}</p>
            </div>
          )}
          {Object.keys(fb.dataQualityCitations).length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-faint">{t("intelReview.mon.dataQuality")}</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {Object.entries(fb.dataQualityCitations).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-ink">{t(`intelReview.dataQuality.${k}`, { defaultValue: k })}</span>
                    <span className="text-ink-muted">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fb.patterns.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-faint">{t("intelReview.mon.patterns")}</p>
              <ul className="mt-1 space-y-1 text-sm text-ink">
                {fb.patterns.map((p) => <li key={p.kind}>{t(`intelReview.pattern.${p.kind}`, { defaultValue: p.kind })} ({p.support})</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The office's exploration counts: areas, completion, skips, declines, evidence volume. No pupil, no reflection. */
function ExplorationAcrossSchool({ schoolId, classId }: { schoolId?: string; classId: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["exploration-summary", schoolId ?? "own", classId], queryFn: () => fetchExplorationSummary({ ...(schoolId ? { schoolId } : {}), ...(classId ? { classId } : {}) }), staleTime: 60_000 });
  const d = q.data;
  if (!d) return null;
  return (
    <Card className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">{t("explore.summaryHeading")}</h3>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="default" label={t("explore.summary.students", { n: d.students })} />
        <Badge variant="default" label={t("explore.summary.explorations", { n: d.explorations })} />
        <Badge variant="default" label={t("explore.summary.evidence", { n: d.evidenceRows })} />
      </div>
      <ul className="space-y-0.5 text-sm">
        {Object.entries(d.byArea).map(([k, v]) => (
          <li key={k} className="flex justify-between gap-2"><span className="text-ink">{t(`strengths.area.${k}`, { defaultValue: k })}</span>
            <span className="text-ink-muted">{t("explore.summary.areaLine", { s: v.students, c: v.completed, k: v.skipped, d: v.notInterested })}</span></li>
        ))}
      </ul>
      {d.frequentlyDeclined.length > 0 && <p className="text-xs text-ink-muted">{t("explore.summary.declined")}: {d.frequentlyDeclined.map((x) => `${x.activityId} (${x.count})`).join(", ")}</p>}
      {d.frequentlySkipped.length > 0 && <p className="text-xs text-ink-muted">{t("explore.summary.skipped")}: {d.frequentlySkipped.map((x) => `${x.activityId} (${x.count})`).join(", ")}</p>}
      <p className="text-xs text-ink-muted">{t("explore.summary.note")}</p>
    </Card>
  );
}

/** The operator's cross-school counts. From recorded reviews only; no pupil. */
function AcrossSchools() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["platform-calibration"], queryFn: fetchPlatformCalibration, staleTime: 60_000 });
  if (q.isError) return null;
  const rows = q.data?.schools ?? [];
  return (
    <Card className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">{t("intelReview.acrossSchools")}</h3>
      {q.isLoading && <PageSpinner />}
      {!q.isLoading && !rows.length && <p className="text-sm text-ink-muted">{t("intelReview.noSchools")}</p>}
      <ul className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <li key={r.schoolId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="font-medium text-ink">{r.schoolName}</span>
            <span className="text-ink-muted">
              {t("intelReview.mon.reviewsRecorded", { n: r.reviews })} · {t("intelReview.mon.reviewers", { n: r.reviewers })}
              {r.engineVersions.length > 0 && ` · v${r.engineVersions.join(", v")}`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The teacher-facing briefing. Shown before the queue, collapsible, never skipped. */
function Briefing() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
          <Info className="h-3.5 w-3.5" /> {t("intelReview.instructions.heading")}
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {t(open ? "intelReview.instructions.hide" : "intelReview.instructions.show")}
        </Button>
      </div>
      {open && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
          {(["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const).map((k) => <li key={k}>{t(`intelReview.instructions.${k}`)}</li>)}
        </ol>
      )}
    </Card>
  );
}

/** What a teacher sees of the pilot: that it is on, its kind, its state. */
function PilotBanner({ pilot }: { pilot: Pilot | LeanPilot }) {
  const { t } = useTranslation();
  return (
    <Card className="flex items-center gap-2 text-sm text-ink">
      <FlaskConical className="h-4 w-4 text-ink-faint" />
      {t("intelReview.pilot.teacherBanner", {
        kind: t(`intelReview.pilot.kind.${pilot.kind}`).toLowerCase(),
        status: t(`intelReview.pilot.status.${pilot.status}`).toLowerCase(),
        v: pilot.engineVersion,
      })}
    </Card>
  );
}

const PILOT_STATUS_VARIANT: Record<PilotStatus, "default" | "info" | "warning" | "success" | "danger"> = {
  READY: "default", ACTIVE: "info", REVIEWING: "info", ANALYSIS_READY: "warning",
  CALIBRATED: "success", INSUFFICIENT_EVIDENCE: "warning", CLOSED: "default",
};

/**
 * The head's pilot frame: open one, move it along, read the evidence as it
 * stands, record the decision, read the report. Every rule is the server's; a
 * refused move comes back with its code and is shown as a sentence.
 *
 * Stage 18: before a REAL pilot opens, the readiness is shown in five groups,
 * each READY, BLOCKED or REQUIRES CONFIRMATION, and the page never says
 * "ready" while any is not. The four confirmations are signed here by the
 * person opening the pilot. A finding is amended only with a reason. The
 * report is the server's counts, rendered.
 */
function PilotPanel({
  pilot, open, classes, schoolId, toast, onChanged,
}: {
  pilot: Pilot | null; open: boolean; classes: Array<{ _id: string; name: string }>; schoolId?: string;
  toast: ReturnType<typeof useToast>["toast"]; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind]   = useState<PilotKind>("development");
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [note, setNote]   = useState("");
  const [outcome, setOutcome] = useState<PilotOutcome>("KEEP");
  const [summary, setSummary] = useState("");
  const [attest, setAttest]   = useState<Attestations>({ schoolParticipates: false, reviewersUnderstandTask: false, noticeRequirementsMet: false, retentionAgreed: false });
  const [showReport, setShowReport] = useState(false);
  const [finding, setFinding] = useState<{ category: FindingCategory; severity: FindingSeverity; summary: string; evidence: string; affectedCases: string; recommendedNextAction: string; disagreementSource: FindingSource }>(
    { category: "DATA_QUALITY", severity: "medium", summary: "", evidence: "", affectedCases: "0", recommendedNextAction: "", disagreementSource: "undetermined" });
  const [amend, setAmend] = useState<Record<string, { status: FindingStatus; disagreementSource: FindingSource; reason: string }>>({});

  const preflightQ = useQuery({
    queryKey: ["pilot-preflight", schoolId ?? "own", scope.join(",")],
    queryFn:  () => fetchPreflight(schoolId, scope),
    enabled:  !open && kind === "real",
    staleTime: 30_000,
  });

  const evidenceQ = useQuery({
    queryKey: ["pilot-evidence", schoolId ?? "own", pilot?.pilotRunId ?? "none"],
    queryFn:  () => fetchPilotEvidence(schoolId),
    enabled:  open,
    staleTime: 30_000,
  });

  const reportQ = useQuery({
    queryKey: ["pilot-report", schoolId ?? "own", pilot?.pilotRunId ?? "none", pilot?.version ?? 0],
    queryFn:  () => fetchPilotReport(pilot!.pilotRunId, schoolId),
    enabled:  Boolean(pilot) && showReport,
    staleTime: 30_000,
  });

  const onError = (err: unknown) => {
    const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
    toast({ kind: "error", title: t(`intelReview.pilot.error.${code ?? "generic"}`, { defaultValue: t("intelReview.pilot.error.generic") }) });
  };
  const raise = useMutation({
    mutationFn: () => addFinding(pilot!.pilotRunId, {
      ...(schoolId ? { schoolId } : {}), category: finding.category, severity: finding.severity, summary: finding.summary,
      evidence: finding.evidence || undefined, affectedCases: Number(finding.affectedCases) || 0,
      recommendedNextAction: finding.recommendedNextAction || undefined, disagreementSource: finding.disagreementSource,
    }),
    onSuccess: async () => { toast({ kind: "success", title: t("intelReview.finding.recorded") }); setFinding((f) => ({ ...f, summary: "", evidence: "", affectedCases: "0", recommendedNextAction: "", disagreementSource: "undetermined" })); await onChanged(); },
    onError,
  });
  const amendFinding = useMutation({
    mutationFn: (p: { findingId: string; status: FindingStatus; disagreementSource: FindingSource; reason: string }) =>
      updateFinding(pilot!.pilotRunId, p.findingId, { ...(schoolId ? { schoolId } : {}), status: p.status, disagreementSource: p.disagreementSource, reason: p.reason }),
    onSuccess: async (_f, p) => { toast({ kind: "success", title: t("intelReview.finding.amended") }); setAmend((a) => { const next = { ...a }; delete next[p.findingId]; return next; }); await onChanged(); },
    onError,
  });
  const create = useMutation({
    mutationFn: () => openPilot({ ...(schoolId ? { schoolId } : {}), kind, label: label || undefined, classIds: scope.length ? scope : undefined,
                                  ...(kind === "real" ? { attestations: attest } : {}) }),
    onSuccess: async () => { toast({ kind: "success", title: t("intelReview.pilot.opened_ok") }); setLabel(""); setScope([]); await onChanged(); },
    onError,
  });
  const advance = useMutation({
    mutationFn: (to: PilotStatus) => advancePilot(pilot!.pilotRunId, {
      ...(schoolId ? { schoolId } : {}), to, version: pilot!.version, note: note || undefined,
      ...(to === "CALIBRATED" || to === "INSUFFICIENT_EVIDENCE" ? { decision: { outcome, summary } } : {}),
    }),
    onSuccess: async () => { toast({ kind: "success", title: t("intelReview.pilot.advanced_ok") }); setNote(""); setSummary(""); await onChanged(); },
    onError,
  });

  const concluding = pilot?.status === "ANALYSIS_READY";
  const evidence = pilot?.evidence ?? evidenceQ.data?.evidence ?? null;
  const allAttested = ATTESTATION_KEYS.every((k) => attest[k]);
  const engineList = (v: EngineVersions | null) => (v ? ENGINE_KEYS.map((k) => `${t(`intelReview.pilot.engineName.${k}`)} ${v[k]}`).join(" · ") : "—");
  const amendOf = (f: PilotFinding) => amend[f.findingId] ?? { status: f.status, disagreementSource: f.disagreementSource ?? "undetermined", reason: "" };
  const reportToggle = pilot && pilot.status !== "READY" && (
    <div className="space-y-2">
      <Button variant="ghost" size="sm" onClick={() => setShowReport((s) => !s)}>{t(showReport ? "intelReview.pilot.hideReport" : "intelReview.pilot.showReport")}</Button>
      {showReport && reportQ.isLoading && <PageSpinner />}
      {showReport && reportQ.data && <PilotReport report={reportQ.data} classes={classes} />}
    </div>
  );

  return (
    <Card className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
        <FlaskConical className="h-3.5 w-3.5" /> {t("intelReview.pilot.heading")}
      </h3>

      {!open && (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">{t("intelReview.pilot.none")}</p>
          <p className="text-xs text-ink-muted">{t("intelReview.pilot.openHint")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label={t("intelReview.pilot.openKind")} required>
              <SelectField value={kind} onChange={(e) => setKind(e.target.value as PilotKind)}
                options={(["development", "real", "synthetic"] as PilotKind[]).map((k) => ({ value: k, label: t(`intelReview.pilot.kind.${k}`) }))} />
            </FormField>
            <FormField label={t("intelReview.pilot.openLabel")}>
              <Textarea rows={1} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
            </FormField>
            <FormField label={t("intelReview.pilot.openScope")}>
              <div className="grid gap-1">
                {classes.map((c) => (
                  <Checkbox key={c._id} label={c.name} checked={scope.includes(c._id)}
                    onChange={(e) => setScope((s) => e.target.checked ? [...s, c._id] : s.filter((x) => x !== c._id))} />
                ))}
              </div>
            </FormField>
          </div>
          {kind === "real" && (
            <div className="space-y-2 rounded-md border border-line p-3">
              <p className="text-xs font-medium text-ink-faint">{t("intelReview.readiness.heading")}</p>
              {preflightQ.isLoading && <PageSpinner />}
              {preflightQ.data && <Readiness pre={preflightQ.data} attest={attest} setAttest={setAttest} />}
            </div>
          )}
          <Button variant="primary"
                  disabled={create.isPending || (kind === "real" && (!preflightQ.data?.ready || !allAttested))}
                  onClick={() => create.mutate()}>{t("intelReview.pilot.open")}</Button>

          {/* The last pilot, closed: its state, its decision, its report. */}
          {pilot && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs font-medium text-ink-faint">{t("intelReview.pilot.lastPilot")}</span>
                <Badge variant={PILOT_STATUS_VARIANT[pilot.status]} label={t(`intelReview.pilot.status.${pilot.status}`)} />
                <Badge variant="default" label={t(`intelReview.pilot.kind.${pilot.kind}`)} />
                {pilot.label && <span className="text-ink">{pilot.label}</span>}
                {pilot.endedAt && <span className="text-xs text-ink-muted">{t("intelReview.pilot.ended")} {new Date(pilot.endedAt).toLocaleDateString()}</span>}
              </div>
              {pilot.decision && <p className="text-sm text-ink">{t("intelReview.pilot.decisionHeading")}: {t(`intelReview.pilot.outcome.${pilot.decision.outcome}`)} — {pilot.decision.summary}</p>}
              {reportToggle}
            </div>
          )}
        </div>
      )}

      {open && pilot && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={PILOT_STATUS_VARIANT[pilot.status]} label={t(`intelReview.pilot.status.${pilot.status}`)} />
            <Badge variant="default" label={t(`intelReview.pilot.kind.${pilot.kind}`)} />
            <Badge variant="default" label={t("intelReview.pilot.engine", { v: pilot.engineVersion })} />
            {pilot.label && <span className="text-ink">{pilot.label}</span>}
            <span className="text-xs text-ink-muted">
              {t("intelReview.pilot.scope")}: {pilot.classIds?.length
                ? pilot.classIds.map((id) => classes.find((c) => c._id === id)?.name ?? id).join(", ")
                : t("intelReview.pilot.wholeSchool")}
            </span>
          </div>
          <p className="text-xs text-ink-muted">{t(`intelReview.pilot.statusHint.${pilot.status}`)}</p>
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer">{t("intelReview.pilot.engineVersions")}</summary>
            <p className="mt-1">{engineList(pilot.engineVersions)}</p>
          </details>
          {pilot.engineDrift.length > 0 && (
            <p className="text-xs text-warning">{t("intelReview.pilot.drift", { list: pilot.engineDrift.map((d) => `${t(`intelReview.pilot.engineName.${d.engine}`)} ${d.pilot} → ${d.current}`).join(", ") })}</p>
          )}

          {evidence && (
            <div>
              <p className="text-xs font-medium text-ink-faint">
                {pilot.evidence ? t("intelReview.pilot.evidenceHeading") : t("intelReview.pilot.liveEvidence")}
              </p>
              <EvidenceGrid evidence={evidence} />
              <p className="mt-2 text-xs text-ink-muted">
                {(pilot.evidence ? pilot.evidenceShortfalls : evidenceQ.data?.shortfalls ?? []).length === 0
                  ? t("intelReview.pilot.gateMet")
                  : t("intelReview.pilot.gate", {
                      list: (pilot.evidence ? pilot.evidenceShortfalls : evidenceQ.data?.shortfalls ?? [])
                        .map((s) => t("intelReview.pilot.shortfall", { req: t(`intelReview.pilot.req.${s.requirement}`), actual: s.actual, min: s.minimum })).join("; "),
                    })}
              </p>
            </div>
          )}

          {/* The explanation layer inside this pilot: counts, never a question. */}
          <div className="text-xs text-ink-muted">
            <p className="font-medium text-ink-faint">{t("intelReview.pilot.advancedHeading")}</p>
            <p>
              {(["requests", "modelValidated", "validatorRejections", "providerFailures", "refused"] as const)
                .map((k) => `${t(`intelReview.pilot.advanced.${k}`)}: ${pilot.advanced[k]}`).join(" · ")}
            </p>
          </div>

          {pilot.decision && (
            <div className="rounded-md border border-line p-3 text-sm">
              <p className="font-medium text-ink">{t("intelReview.pilot.decisionHeading")}: {t(`intelReview.pilot.outcome.${pilot.decision.outcome}`)}</p>
              <p className="mt-1 text-ink">{pilot.decision.summary}</p>
              <p className="mt-1 text-xs text-ink-muted">{new Date(pilot.decision.recordedAt).toLocaleString()} · {t("intelReview.pilot.by", { who: pilot.decision.recordedBy })}</p>
            </div>
          )}

          {pilot.allowedTransitions.length > 0 && (
            <div className="space-y-2">
              {concluding && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label={t("intelReview.pilot.decisionOutcome")}>
                    <SelectField value={outcome} onChange={(e) => setOutcome(e.target.value as PilotOutcome)}
                      options={(["KEEP", "CALIBRATE"] as PilotOutcome[]).map((o) => ({ value: o, label: t(`intelReview.pilot.outcome.${o}`) }))} />
                  </FormField>
                  <FormField label={t("intelReview.pilot.decisionSummary")} required>
                    <Textarea rows={3} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
                  </FormField>
                </div>
              )}
              <FormField label={t("intelReview.pilot.note")}>
                <Textarea rows={1} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </FormField>
              <div className="flex flex-wrap gap-2">
                {pilot.allowedTransitions.map((to) => (
                  <Button key={to} variant={to === "CLOSED" ? "secondary" : "primary"} size="sm"
                          disabled={advance.isPending || ((to === "CALIBRATED" || to === "INSUFFICIENT_EVIDENCE") && summary.trim().length < 20) || (to === "CALIBRATED" && pilot.engineDrift.length > 0)}
                          onClick={() => advance.mutate(to)}>
                    {t("intelReview.pilot.advance", { state: t(`intelReview.pilot.status.${to}`) })}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Findings: what the pilot turned up, by category, never a verdict about a child. Amended only with a reason. */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-ink-faint">{t("intelReview.finding.heading")} ({pilot.findings.length})</p>
            <p className="text-xs text-ink-muted">{t("intelReview.finding.sourceNote")}</p>
            {pilot.findings.map((f) => (
              <div key={f.findingId} className="rounded-md border border-line p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "default"} label={t(`intelReview.finding.severity.${f.severity}`)} />
                  <Badge variant="default" label={t(`intelReview.finding.category.${f.category}`)} />
                  <Badge variant="info" label={t(`intelReview.finding.status.${f.status}`)} />
                  <span className="font-medium text-ink">{f.summary}</span>
                  <span className="text-xs text-ink-muted">v{f.engineVersion} · {f.affectedCases} {t("intelReview.finding.cases")}</span>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{t("intelReview.finding.sourceLabel")}: {t(`intelReview.finding.source.${f.disagreementSource ?? "undetermined"}`)}</p>
                {f.evidence && <p className="mt-1 text-xs text-ink-muted">{f.evidence}</p>}
                {f.recommendedNextAction && <p className="mt-1 text-xs text-ink">{t("intelReview.finding.next")}: {f.recommendedNextAction}</p>}
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-ink-muted">{t("intelReview.finding.amend")}</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <FormField label={t("intelReview.finding.status.label")}>
                      <SelectField value={amendOf(f).status} onChange={(e) => setAmend((a) => ({ ...a, [f.findingId]: { ...amendOf(f), status: e.target.value as FindingStatus } }))}
                        options={(["open", "investigating", "confirmed", "resolved", "not_reproduced"] as FindingStatus[]).map((s) => ({ value: s, label: t(`intelReview.finding.status.${s}`) }))} />
                    </FormField>
                    <FormField label={t("intelReview.finding.sourceLabel")}>
                      <SelectField value={amendOf(f).disagreementSource} onChange={(e) => setAmend((a) => ({ ...a, [f.findingId]: { ...amendOf(f), disagreementSource: e.target.value as FindingSource } }))}
                        options={(["undetermined", "data_quality", "missing_context", "insufficient_evidence", "interpretation_ambiguity", "rule_weakness"] as FindingSource[]).map((s) => ({ value: s, label: t(`intelReview.finding.source.${s}`) }))} />
                    </FormField>
                    <FormField label={t("intelReview.finding.reasonLabel")} required>
                      <Textarea rows={1} value={amendOf(f).reason} maxLength={1000} onChange={(e) => setAmend((a) => ({ ...a, [f.findingId]: { ...amendOf(f), reason: e.target.value } }))} />
                    </FormField>
                  </div>
                  <Button variant="secondary" size="sm" disabled={amendFinding.isPending || amendOf(f).reason.trim().length < 5}
                          onClick={() => amendFinding.mutate({ findingId: f.findingId, ...amendOf(f) })}>{t("intelReview.finding.amend")}</Button>
                </details>
                {f.amendments?.length > 0 && (
                  <details className="mt-1 text-xs text-ink-muted">
                    <summary className="cursor-pointer">{t("intelReview.finding.amendments")} ({f.amendments.length})</summary>
                    <ul className="mt-1 space-y-0.5">
                      {f.amendments.map((a, i) => (
                        <li key={i}>{new Date(a.at).toLocaleString()} · {t("intelReview.pilot.by", { who: a.by })} · {a.changes.map((c) => `${c.field}: ${String(c.from ?? "—")} → ${String(c.to ?? "—")}`).join("; ")} · {a.reason}{a.pilotClosed ? ` · ${t("intelReview.finding.afterClosure")}` : ""}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
            {pilot.status !== "CLOSED" && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-ink-muted">{t("intelReview.finding.add")}</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <FormField label={t("intelReview.finding.categoryLabel")}>
                    <SelectField value={finding.category} onChange={(e) => setFinding((f) => ({ ...f, category: e.target.value as FindingCategory }))}
                      options={(["ENGINE", "DATA_QUALITY", "MAPPING", "AUTHORIZATION", "UX", "MISSING_EVIDENCE", "GUIDANCE", "REVIEW_WORKFLOW", "OFFLINE_CONSISTENCY", "ADVANCED_INTELLIGENCE"] as FindingCategory[]).map((c) => ({ value: c, label: t(`intelReview.finding.category.${c}`) }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.severityLabel")}>
                    <SelectField value={finding.severity} onChange={(e) => setFinding((f) => ({ ...f, severity: e.target.value as FindingSeverity }))}
                      options={(["low", "medium", "high"] as FindingSeverity[]).map((s) => ({ value: s, label: t(`intelReview.finding.severity.${s}`) }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.summaryLabel")} required>
                    <Textarea rows={2} value={finding.summary} maxLength={500} onChange={(e) => setFinding((f) => ({ ...f, summary: e.target.value }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.evidenceLabel")}>
                    <Textarea rows={2} value={finding.evidence} maxLength={4000} onChange={(e) => setFinding((f) => ({ ...f, evidence: e.target.value }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.affectedLabel")}>
                    <Textarea rows={1} value={finding.affectedCases} onChange={(e) => setFinding((f) => ({ ...f, affectedCases: e.target.value }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.nextLabel")}>
                    <Textarea rows={1} value={finding.recommendedNextAction} maxLength={1000} onChange={(e) => setFinding((f) => ({ ...f, recommendedNextAction: e.target.value }))} />
                  </FormField>
                  <FormField label={t("intelReview.finding.sourceLabel")}>
                    <SelectField value={finding.disagreementSource} onChange={(e) => setFinding((f) => ({ ...f, disagreementSource: e.target.value as FindingSource }))}
                      options={(["undetermined", "data_quality", "missing_context", "insufficient_evidence", "interpretation_ambiguity", "rule_weakness"] as FindingSource[]).map((s) => ({ value: s, label: t(`intelReview.finding.source.${s}`) }))} />
                  </FormField>
                </div>
                <Button variant="secondary" size="sm" disabled={raise.isPending || finding.summary.trim().length < 10} onClick={() => raise.mutate()}>
                  {t("intelReview.finding.record")}
                </Button>
              </details>
            )}
          </div>

          {reportToggle}

          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer">{t("intelReview.pilot.trail")}</summary>
            <ul className="mt-1 space-y-0.5">
              {pilot.transitions.map((x, i) => (
                <li key={i}>{new Date(x.at).toLocaleString()} · {x.from ?? "—"} → {t(`intelReview.pilot.status.${x.to}`)} · {t("intelReview.pilot.by", { who: x.by })}{x.note ? ` · ${x.note}` : ""}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </Card>
  );
}

const READINESS_VARIANT: Record<ReadinessStatus, "success" | "danger" | "warning"> = { READY: "success", BLOCKED: "danger", REQUIRES_CONFIRMATION: "warning" };

/**
 * The five readiness groups, each answered on its own. A manual check is a
 * confirmation the person opening the pilot signs here; the page never calls
 * the pilot ready while any group is BLOCKED, and says what is missing in the
 * server's words.
 */
function Readiness({ pre, attest, setAttest }: { pre: Preflight; attest: Attestations; setAttest: (f: (a: Attestations) => Attestations) => void }) {
  const { t } = useTranslation();
  const groups = ["technical", "operational", "evidence", "reviewer", "privacy"] as const;
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g} className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{t(`intelReview.readiness.group.${g}`)}</span>
            <Badge variant={READINESS_VARIANT[pre.readiness[g].status]} label={t(`intelReview.readiness.status.${pre.readiness[g].status}`)} />
          </div>
          <ul className="space-y-0.5 text-sm">
            {pre.checks.filter((c) => c.group === g).map((c) => (
              <li key={c.key} className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-3">
                {c.kind === "manual" ? (
                  <Checkbox label={t(`intelReview.preflight.check.${c.key}`, { defaultValue: c.key })} checked={attest[c.key as AttestationKey] ?? false}
                            onChange={(e) => setAttest((a) => ({ ...a, [c.key]: e.target.checked }))} />
                ) : (
                  <span className={c.ok ? "text-ink" : "text-warning"}>{c.ok ? "✓" : "✗"} {t(`intelReview.preflight.check.${c.key}`, { defaultValue: c.key })}</span>
                )}
                <span className="text-right text-xs text-ink-muted">{c.kind === "manual" && g === "privacy" ? t("intelReview.readiness.confirmNote") : c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className={pre.ready ? "text-xs text-ink-muted" : "text-xs font-medium text-warning"}>
        {pre.ready ? t("intelReview.readiness.awaiting") : t("intelReview.readiness.blocked", { missing: pre.missing.join(", ") })}
      </p>
      <p className="text-xs text-ink-muted">{t("intelReview.readiness.note")}</p>
    </div>
  );
}

function EvidenceGrid({ evidence }: { evidence: PilotEvidence }) {
  const { t } = useTranslation();
  const nums = ["casesSelected", "casesReviewed", "casesAwaitingReview", "casesWithMultipleReviews", "studentsReviewed", "reviewsRecorded", "reviewers", "reviewsExcluded"] as const;
  const lists = ["categories", "subjects", "temporalPatterns", "repeatedDisagreements"] as const;
  const label = (k: string, list: (typeof lists)[number]) =>
    list === "categories" || list === "repeatedDisagreements" ? t(`intelReview.category.${k}`, { defaultValue: k })
      : list === "temporalPatterns" ? t(`intelReview.code.${k}`, { defaultValue: k }) : k;
  return (
    <div className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      {nums.map((k) => (
        <div key={k} className="flex justify-between gap-2 border-b border-line py-1">
          <span className="text-ink-muted">{t(`intelReview.pilot.ev.${k}`)}</span>
          <span className="font-medium text-ink">{evidence[k] ?? 0}</span>
        </div>
      ))}
      <div className="flex justify-between gap-2 border-b border-line py-1">
        <span className="text-ink-muted">{t("intelReview.pilot.ev.engineVersionsMatch")}</span>
        <span className="font-medium text-ink">{t(evidence.engineVersionsMatch === false ? "intelReview.pilot.no" : "intelReview.pilot.yes")}</span>
      </div>
      {lists.map((k) => (
        <div key={k} className="flex justify-between gap-2 border-b border-line py-1">
          <span className="text-ink-muted">{t(`intelReview.pilot.ev.${k}`)}</span>
          <span className="text-right font-medium text-ink">{evidence[k].length ? evidence[k].map((x) => label(x, k)).join(", ") : "—"}</span>
        </div>
      ))}
      <div className="flex justify-between gap-2 border-b border-line py-1">
        <span className="text-ink-muted">{t("intelReview.pilot.ev.dataQualityCitations")}</span>
        <span className="text-right font-medium text-ink">
          {Object.entries(evidence.dataQualityCitations).map(([k, v]) => `${t(`intelReview.dataQuality.${k}`, { defaultValue: k })} (${v})`).join(", ") || "—"}
        </span>
      </div>
      <div className="flex justify-between gap-2 border-b border-line py-1">
        <span className="text-ink-muted">{t("intelReview.pilot.ev.byOutcome")}</span>
        <span className="text-right font-medium text-ink">
          {Object.entries(evidence.byOutcome).filter(([, v]) => v > 0).map(([k, v]) => `${t(`intelReview.outcome.${k}`, { defaultValue: k })} (${v})`).join(", ") || "—"}
        </span>
      </div>
    </div>
  );
}

const ReportRow = ({ label, value }: { label: string; value: string | number }) => (
  <div className="flex justify-between gap-2 border-b border-line py-1"><span className="text-ink-muted">{label}</span><span className="text-right font-medium text-ink">{value}</span></div>
);
const ReportSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="space-y-1"><p className="text-xs font-medium text-ink-faint">{title}</p>{children}</div>
);

/**
 * The real-world validation report, rendered from the server's counts:
 * scope, coverage, outcomes, the four concerns, the explanation layer, the
 * pupils' answers, the findings, and what was and was not tested. Nothing on
 * it is a score, a rank or a winner, and nothing on it names a pupil.
 */
function PilotReport({ report, classes }: { report: PilotReport; classes: Array<{ _id: string; name: string }> }) {
  const { t } = useTranslation();
  const day = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");
  const cov = report.evidenceCoverage, adv = report.advancedIntelligence, fb = report.studentFeedback;
  return (
    <div className="space-y-3 rounded-md border border-line p-3 text-sm">
      <p className="font-medium text-ink">{t("intelReview.report.heading")}</p>
      <p className="text-xs text-ink-muted">{t("intelReview.report.intro")}</p>

      <ReportSection title={t("intelReview.report.scope")}>
        <p className="text-ink">
          {t(`intelReview.pilot.kind.${report.scope.kind}`)} · {report.scope.classIds?.length ? report.scope.classIds.map((id) => classes.find((c) => c._id === id)?.name ?? id).join(", ") : t("intelReview.pilot.wholeSchool")}
          {" · "}{t("intelReview.report.dates", { from: day(report.scope.startedAt ?? report.scope.createdAt), to: day(report.scope.endedAt) })}
        </p>
        <p className="text-xs text-ink-muted">{t("intelReview.report.casesReviewers", { cases: report.scope.cases, reviewers: report.scope.reviewers, students: report.scope.students })}</p>
        <p className="text-xs text-ink-muted">{report.scope.engineVersions ? ENGINE_KEYS.map((k) => `${t(`intelReview.pilot.engineName.${k}`)} ${report.scope.engineVersions![k]}`).join(" · ") : "—"}</p>
        {report.scope.engineDrift.length > 0 && <p className="text-xs text-warning">{t("intelReview.pilot.drift", { list: report.scope.engineDrift.map((d) => `${t(`intelReview.pilot.engineName.${d.engine}`)} ${d.pilot} → ${d.current}`).join(", ") })}</p>}
      </ReportSection>

      <ReportSection title={t("intelReview.report.coverage")}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {(["reviewable", "reviewed", "multiReviewed", "incomplete", "reviewsRecorded", "reviewsExcluded", "studentsReviewed"] as const).map((k) => <ReportRow key={k} label={t(`intelReview.report.cov.${k}`)} value={cov[k]} />)}
        </div>
        {cov.evidenceQualityLimitations.length > 0 && (
          <p className="text-xs text-ink-muted">{t("intelReview.report.cov.limitations")}: {cov.evidenceQualityLimitations.map((l) => `${t(`intelReview.dataQuality.${l.code}`, { defaultValue: l.code })} (${l.reviews})`).join(", ")}</p>
        )}
      </ReportSection>

      <ReportSection title={t("intelReview.report.outcomes")}>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {(Object.keys(report.reviewOutcomes) as Array<keyof typeof report.reviewOutcomes>).map((k) => <ReportRow key={k} label={t(`intelReview.report.outcome.${k}`)} value={report.reviewOutcomes[k]} />)}
        </div>
      </ReportSection>

      <ReportSection title={t("intelReview.report.concerns")}>
        <p className="text-xs text-ink-muted">{t("intelReview.concern.note")}</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {(Object.keys(report.concerns) as Array<keyof typeof report.concerns>).map((k) => (
            <ReportRow key={k} label={t(`intelReview.report.concern.${k}`)}
                 value={`${t("intelReview.report.reviewsN", { n: report.concerns[k].reviews })}${report.concerns[k].examples.length ? ` · ${t("intelReview.report.examples")}: ${report.concerns[k].examples.map((e) => `${t(`intelReview.dataQuality.${e.code}`, { defaultValue: t(`intelReview.code.${e.code}`, { defaultValue: e.code }) })} (${e.reviews})`).join(", ")}` : ""}`} />
          ))}
        </div>
      </ReportSection>

      <ReportSection title={t("intelReview.report.advanced")}>
        <p className="text-xs text-ink-muted">{t("intelReview.report.adv.validatorNote")}</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <ReportRow label={t("intelReview.report.adv.requests")} value={adv.requests} />
          <ReportRow label={t("intelReview.report.adv.explanation", { kept: adv.explanationValidation.modelAnswersKept, rejected: adv.explanationValidation.modelAnswersRejected })} value="" />
          <ReportRow label={t("intelReview.report.adv.citations")} value={Object.entries(adv.citationValidation).map(([k, v]) => `${k} ${v}`).join(" · ")} />
          <ReportRow label={t("intelReview.report.adv.safety")} value={Object.entries(adv.safety).map(([k, v]) => `${k} ${v}`).join(" · ")} />
          <ReportRow label={t("intelReview.report.adv.providerFailures")} value={adv.providerFailures} />
          <ReportRow label={t("intelReview.report.adv.fallback")} value={Object.entries(adv.fallbackUsage).map(([k, v]) => `${t(`explain.mode.${k}`, { defaultValue: k })} ${v}`).join(" · ")} />
        </div>
      </ReportSection>

      <ReportSection title={t("intelReview.report.feedback")}>
        <p className="text-ink">{t("intelReview.report.fb.responses", { n: fb.responses })}</p>
        {fb.withheld && fb.responses > 0 && <p className="text-xs text-ink-muted">{t("intelReview.report.fb.withheld", { min: fb.minimumForBreakdown })}</p>}
        {fb.byQuestion && (
          <div className="grid gap-x-4">
            {fb.questions.map((q) => (
              <ReportRow key={q} label={t(`intelReview.report.fb.q.${q}`, { defaultValue: q })}
                   value={fb.answers.map((a) => `${t(`intelReview.report.fb.a.${a}`, { defaultValue: a })} ${fb.byQuestion![q]?.[a] ?? 0}`).join(" · ")} />
            ))}
          </div>
        )}
      </ReportSection>

      <ReportSection title={t("intelReview.report.findings")}>
        <p className="text-ink">{report.findings.total} · {Object.entries(report.findings.byCategory).map(([k, v]) => `${t(`intelReview.finding.category.${k}`, { defaultValue: k })} ${v}`).join(" · ") || "—"}</p>
        {Object.keys(report.findings.byDisagreementSource).length > 0 && (
          <p className="text-xs text-ink-muted">{t("intelReview.finding.sourceLabel")}: {Object.entries(report.findings.byDisagreementSource).map(([k, v]) => `${t(`intelReview.finding.source.${k}`, { defaultValue: k })} ${v}`).join(" · ")}</p>
        )}
      </ReportSection>

      {report.decision && (
        <ReportSection title={t("intelReview.pilot.decisionHeading")}>
          <p className="text-ink">{t(`intelReview.pilot.outcome.${report.decision.outcome}`)} — {report.decision.summary}</p>
        </ReportSection>
      )}

      <ReportSection title={t("intelReview.report.limitations")}>
        {(["tested", "notTested", "evidenceSupports", "unknown"] as const).map((k) => (
          <p key={k} className="text-xs text-ink-muted">
            <span className="font-medium text-ink">{t(`intelReview.report.${k === "evidenceSupports" ? "supports" : k}`)}:</span>{" "}
            {report.limitations[k].map((c) => t(`intelReview.report.lim.${c}`, { defaultValue: c })).join("; ") || "—"}
          </p>
        ))}
        <p className="text-xs text-ink-muted"><span className="font-medium text-ink">{t("intelReview.report.notClaimed")}</span> {report.notClaimed.map((c) => t(`intelReview.report.claim.${c}`, { defaultValue: c })).join("; ")}</p>
      </ReportSection>
    </div>
  );
}

/** One button: the pupil through both paths, diffed on the server. */
function ConsistencyCheck({ studentId, schoolId }: { studentId: string; schoolId?: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["consistency", studentId], queryFn: () => fetchConsistency(studentId, schoolId), enabled: false });
  return (
    <div className="mt-3 space-y-1">
      <Button variant="ghost" size="sm" disabled={q.isFetching} onClick={() => q.refetch()}>{t("intelReview.consistency.check")}</Button>
      {q.data && (
        <p className={q.data.identical ? "text-xs text-ink-muted" : "text-xs text-warning"}>
          {q.data.identical
            ? t("intelReview.consistency.identical", { v: q.data.engineVersion.live })
            : t("intelReview.consistency.differs", { n: q.data.differences.length })}
        </p>
      )}
      {q.data && !q.data.identical && (
        <ul className="font-mono text-xs text-ink-muted">
          {q.data.differences.slice(0, 10).map((d) => <li key={d.path}>{d.path}: {JSON.stringify(d.live)} ≠ {JSON.stringify(d.offline)}</li>)}
        </ul>
      )}
    </div>
  );
}

function Section({ heading, hint, children }: { heading: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
        <ClipboardCheck className="h-3.5 w-3.5" /> {heading}
      </h3>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      {children}
    </section>
  );
}
