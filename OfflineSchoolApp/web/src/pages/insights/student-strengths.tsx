// web/src/pages/insights/student-strengths.tsx
//
// One pupil's strengths and exploration profile, for the teacher and the head.
//
//   what the evidence suggests strength in → why (the evidence) → what is
//   emerging → what is fading → areas worth exploring → what the pupil has
//   tried or enjoyed → what is still uncertain → what this never infers
//
// ── Wording, fixed ───────────────────────────────────────────────────────────
//
// "Evidence suggests strength in", "recurring evidence appears in" — never
// "is naturally", never "will become". The page shows exploration AREAS with
// ways to explore them; it names no career and ranks nothing but evidence
// level. Every number here is the server's.
//
// ── Two kinds of thing on one screen, never blended ──────────────────────────
//
// System evidence (the profile) and teacher judgement (a confirmation, which
// is an ordinary review of category "strength" — stored apart, hidden from
// colleagues until they answer, and changing nothing in the engine's reading).
// Interest and exposure a pupil or teacher recorded sit in their own section
// and are never shown as strengths.

import { useState }                                from "react";
import { useParams }                               from "react-router-dom";
import { useQuery, useMutation, useQueryClient }   from "@tanstack/react-query";
import { useTranslation }                          from "react-i18next";
import { Sparkles, Compass, EyeOff, TrendingDown, ShieldOff, History, Route, GitCompare, AlertTriangle, BookOpen } from "lucide-react";

import { useUser }      from "@/store/auth.store";
import { PageHeader }   from "@/components/ui/PageHeader";
import { Card }         from "@/components/ui/Card";
import { Button }       from "@/components/ui/Button";
import { Badge }        from "@/components/ui/Badge";
import { PageSpinner }  from "@/components/ui/Spinner";
import { useToast }     from "@/components/ui/Toast";
import { FormField, Textarea, SelectField, Checkbox } from "@/components/ui/FormField";
import {
  fetchStrengths, fetchStrengthProfile, fetchStrengthEvidence, snapshotStrengthProfile, recordExplorationEvidence, submitReview,
  fetchExplorations, fetchCatalog, observeExploration, rateExploration, fetchProfileChanges, rebuildProfile,
  fetchLearningEvidence, fetchLearningChanges, rebuildLearningEvidence,
  type DimensionReading, type RecordedReview, type ExplorationRow, type ChangeEntry, type SeriesReading, type SubjectLearning, type AttendanceReading,
} from "@/services/insights.service";

const OBS_LEVELS = ["OBSERVED", "PARTLY_OBSERVED", "NOT_OBSERVED", "INSUFFICIENT_OPPORTUNITY"];
const OBS_CODES  = ["PROBLEM_SOLVING", "PERSISTENCE", "COMMUNICATION", "TECHNICAL_EXECUTION", "CREATIVE_APPROACH", "COLLABORATION", "EXPLANATION", "ITERATION"];
const RATINGS    = ["not_met", "partly_met", "met", "exceeded"];

const DIMENSIONS = ["quantitative_reasoning", "scientific_reasoning", "language_communication", "reading_interpretation", "analytical_reasoning",
  "creative_expression", "social_collaborative", "technical_applied", "organizational_structured", "visual_spatial"];
const AREAS = ["quantitative_scientific", "mathematical", "life_sciences", "computational_technical", "language_media", "humanities_social",
  "creative_arts", "design_spatial", "organisation_enterprise", "collaborative_service"];

const LEVEL_VARIANT = { strong: "success", emerging: "info", limited: "default" } as const;
const CONF_VARIANT  = { strong: "success", emerging: "info", insufficient: "default" } as const;

export default function StudentStrengthsPage() {
  const { studentId = "" } = useParams();
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();
  const user      = useUser();
  const isOperator = user?.role === "super_admin";
  const schoolId   = isOperator ? (user?.schoolId || "") : undefined;
  const isStaff    = user?.role !== "student";

  const strengthsQ = useQuery({ queryKey: ["strengths", studentId, schoolId], queryFn: () => fetchStrengths(studentId, schoolId), enabled: !!studentId });
  const profileQ   = useQuery({ queryKey: ["strength-profile", studentId, schoolId], queryFn: () => fetchStrengthProfile(studentId, schoolId), enabled: !!studentId });
  const evidenceQ  = useQuery({ queryKey: ["strength-evidence", studentId, schoolId], queryFn: () => fetchStrengthEvidence(studentId, schoolId), enabled: !!studentId && isStaff });

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["strengths", studentId] }),
    qc.invalidateQueries({ queryKey: ["strength-profile", studentId] }),
    qc.invalidateQueries({ queryKey: ["strength-evidence", studentId] }),
  ]);

  if (strengthsQ.isLoading) return <PageSpinner />;
  const data = strengthsQ.data;
  const p = data?.profile ?? null;

  return (
    <div className="space-y-5">
      <PageHeader title={data?.name ? t("strengths.titleFor", { name: data.name }) : t("strengths.title")} description={t("strengths.blurb")} />

      {strengthsQ.isError && <Card className="ring-warning-line"><p className="text-sm text-warning">{t("strengths.unavailable")}</p></Card>}

      {p && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={CONF_VARIANT[p.confidence]} label={t(`strengths.confidence.${p.confidence}`)} />
            <Badge variant="default" label={t("strengths.coverage", { seq: p.evidenceCoverage.sequences, subj: p.evidenceCoverage.subjects })} />
            <Badge variant="default" label={t("strengths.versions", { a: p.academicEngineVersion ?? "—", s: p.strengthEngineVersion })} />
            <Badge variant="default" label={t("strengths.strongMark", { m: p.grading.strongMark })} />
          </div>
          <p className="mt-2 text-xs text-ink-muted">{t("strengths.confidenceMeans")}</p>
        </Card>
      )}

      {p && !p.evidenceCoverage.sufficient && (
        <Card><p className="text-sm text-ink">{t("strengths.insufficientBody")}</p></Card>
      )}

      {/* ── What changed since the last snapshot ─────────────────────── */}
      <WhatChanged studentId={studentId} schoolId={schoolId} />

      {/* ── Conflicting evidence, reported as a pattern ──────────────── */}
      {p?.fusion && p.fusion.contradictions.length > 0 && (
        <Section icon={<AlertTriangle className="h-3.5 w-3.5" />} heading={t("strengths.fusion.conflictsHeading")} hint={t("strengths.fusion.conflictsHint")}>
          <ul className="space-y-1 text-sm">
            {p.fusion.contradictions.map((c, i) => (
              <li key={i} className="text-ink">
                <span className="font-medium">{t(`strengths.dimension.${c.dimension}`, { defaultValue: c.dimension })}</span> — {t(`strengths.fusion.conflict.${c.kind}`, { defaultValue: c.kind })}
                <span className="text-xs text-ink-muted">
                  {c.academic ? ` · ${t("strengths.fusion.src.academic")}: ${t(`strengths.state.${c.academic}`)}` : ""}
                  {c.exploration ? ` · ${t("strengths.fusion.src.exploration")}: ${t(`strengths.fusion.mix.${c.exploration}`, { defaultValue: c.exploration })}` : ""}
                  {c.teacherObservation ? ` · ${t("strengths.fusion.src.observation")}: ${c.teacherObservation}` : ""}
                  {c.interest ? ` · ${t("strengths.fusion.src.interest")}: ${c.interest} / ${c.performance}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── Strength in ─────────────────────────────────────────────── */}
      <Section icon={<Sparkles className="h-3.5 w-3.5" />} heading={t("strengths.establishedHeading")} hint={t("strengths.establishedHint")}>
        {p?.strengths.length ? p.strengths.map((d) => <DimensionCard key={d.dimension} d={d} reviews={data?.reviews} studentId={studentId} schoolId={schoolId} isStaff={isStaff} onChanged={refresh} toast={toast} />)
          : <p className="text-sm text-ink-muted">{t("strengths.none")}</p>}
        {p?.singleSubjectStrengths.map((s) => (
          <Card key={s.subjectId} className="text-sm">
            <p className="font-medium text-ink">{s.subjectName ?? s.subjectId} <span className="font-normal text-ink-muted">· {t("strengths.singleSubject")}</span></p>
            <p className="text-xs text-ink-muted">{t(`strengths.state.${s.state}`)} · {t(`strengths.persistence.${s.persistence}`)} · {s.consistency ? t(`strengths.consistency.${s.consistency}`) : "—"}</p>
          </Card>
        ))}
      </Section>

      {/* ── Emerging ───────────────────────────────────────────────── */}
      <Section icon={<Sparkles className="h-3.5 w-3.5" />} heading={t("strengths.emergingHeading")} hint={t("strengths.emergingHint")}>
        {p?.emergingAreas.length ? p.emergingAreas.map((d) => <DimensionCard key={d.dimension} d={d} reviews={data?.reviews} studentId={studentId} schoolId={schoolId} isStaff={isStaff} onChanged={refresh} toast={toast} />)
          : <p className="text-sm text-ink-muted">{t("strengths.noneEmerging")}</p>}
      </Section>

      {/* ── Evidence against ───────────────────────────────────────── */}
      {p && p.decliningAreas.length > 0 && (
        <Section icon={<TrendingDown className="h-3.5 w-3.5" />} heading={t("strengths.decliningHeading")} hint={t("strengths.decliningHint")}>
          {p.decliningAreas.map((d) => <DimensionCard key={d.dimension} d={d} studentId={studentId} schoolId={schoolId} isStaff={false} onChanged={refresh} toast={toast} />)}
        </Section>
      )}

      {/* ── Areas to explore ───────────────────────────────────────── */}
      <Section icon={<Compass className="h-3.5 w-3.5" />} heading={t("strengths.areasHeading")} hint={t("strengths.areasHint")}>
        {p?.explorationAreas.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {p.explorationAreas.map((a) => (
              <Card key={a.area} className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{t(`strengths.area.${a.area}`, { defaultValue: a.area })}</span>
                  <Badge variant={LEVEL_VARIANT[a.evidenceLevel]} label={t(`strengths.level.${a.evidenceLevel}`)} />
                </div>
                <p className="text-xs text-ink-muted">
                  {t("strengths.because")}: {a.because.map((b) => `${t(`strengths.dimension.${b.dimension}`, { defaultValue: b.dimension })} (${t(`strengths.state.${b.state}`).toLowerCase()})`).join("; ")}
                  {a.supportingSubjects.length > 0 && ` · ${a.supportingSubjects.map((s) => s.subjectName ?? s.subjectId).join(", ")}`}
                </p>
                <div>
                  <p className="text-xs font-medium text-ink-faint">{t("strengths.waysToExplore")}</p>
                  <ul className="list-disc pl-5 text-ink">{a.waysToExplore.map((w) => <li key={w}>{t(`strengths.activity.${w}`, { defaultValue: w })}</li>)}</ul>
                </div>
              </Card>
            ))}
          </div>
        ) : <p className="text-sm text-ink-muted">{t("strengths.noAreas")}</p>}
      </Section>

      {/* ── Interest and exposure — apart ─────────────────────────── */}
      <Section icon={<Compass className="h-3.5 w-3.5" />} heading={t("strengths.signalsHeading")} hint={t("strengths.signalsHint")}>
        {p?.interestSignals.length ? (
          <ul className="space-y-1 text-sm">
            {p.interestSignals.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Badge variant="default" label={t(`strengths.kind.${s.kind}`)} />
                <span className="text-ink">{s.activity}</span>
                <span className="text-xs text-ink-muted">
                  {s.dimension ? t(`strengths.dimension.${s.dimension}`, { defaultValue: s.dimension }) : s.area ? t(`strengths.area.${s.area}`, { defaultValue: s.area }) : ""}
                  {s.date ? ` · ${new Date(s.date).toLocaleDateString()}` : ""}
                  {s.participation ? ` · ${t(`strengths.participation.${s.participation}`)}` : ""}
                  {s.reflection ? ` · ${t(`strengths.reflection.${s.reflection}`)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t("strengths.noSignals")}</p>}
        {isStaff && <RecordEvidence studentId={studentId} schoolId={schoolId} onChanged={refresh} toast={toast} />}
      </Section>

      {/* ── Uncertainty, and the non-inference list ───────────────── */}
      <Section icon={<EyeOff className="h-3.5 w-3.5" />} heading={t("strengths.uncertainHeading")}>
        <ul className="list-disc pl-5 text-sm text-ink">
          {(p?.limitations ?? ["no_academic_profile"]).map((l) => <li key={l}>{t(`strengths.limitation.${l}`, { defaultValue: l })}</li>)}
        </ul>
      </Section>
      <Section icon={<ShieldOff className="h-3.5 w-3.5" />} heading={t("strengths.notInferredHeading")} hint={t("strengths.notInferredHint")}>
        <p className="text-sm text-ink">{(p?.notInferred ?? []).map((k) => t(`strengths.notInferred.${k}`, { defaultValue: k })).join(" · ")}</p>
      </Section>

      {/* ── Learning evidence: the school's own records, by kind ──────── */}
      <LearningEvidence studentId={studentId} schoolId={schoolId} isStaff={isStaff} toast={toast} />

      {/* ── Explorations: what the pupil tried, apart from the reading ── */}
      {isStaff && <Explorations studentId={studentId} schoolId={schoolId} toast={toast} onChanged={refresh} />}

      {/* ── Longitudinal ───────────────────────────────────────────── */}
      <Section icon={<History className="h-3.5 w-3.5" />} heading={t("strengths.historyHeading")} hint={t("strengths.historyHint")}>
        {isStaff && p && <SnapshotButton studentId={studentId} schoolId={schoolId} onChanged={refresh} toast={toast} />}
        {(profileQ.data?.history ?? []).length ? (
          <ul className="space-y-1 text-sm">
            {profileQ.data!.history.map((h) => (
              <li key={h.snapshotId} className="flex flex-wrap items-center gap-2">
                <Badge variant="default" label={`v${h.profileVersion}`} />
                <span className="text-ink">{h.periodLabel ?? new Date(h.generatedAt).toLocaleDateString()}</span>
                <span className="text-xs text-ink-muted">
                  {t("strengths.historyLine", { s: h.profile.strengths.map((d) => t(`strengths.dimension.${d.dimension}`, { defaultValue: d.dimension })).join(", ") || "—",
                    e: h.profile.emergingAreas.map((d) => t(`strengths.dimension.${d.dimension}`, { defaultValue: d.dimension })).join(", ") || "—", v: h.strengthEngineVersion })}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-muted">{t("strengths.noHistory")}</p>}
      </Section>
      {evidenceQ.isError && null}
    </div>
  );
}

function DimensionCard({ d, reviews, studentId, schoolId, isStaff, onChanged, toast }: {
  d: DimensionReading; reviews?: RecordedReview[]; studentId: string; schoolId?: string; isStaff: boolean;
  onChanged: () => Promise<unknown>; toast: ReturnType<typeof useToast>["toast"];
}) {
  const { t } = useTranslation();
  const mine = reviews?.filter((r) => r.review && (r as unknown as { subjectId?: string }).subjectId === d.dimension) ?? [];
  const [answer, setAnswer] = useState("");
  const confirm = useMutation({
    mutationFn: () => submitReview({
      ...(schoolId ? { schoolId } : {}), studentId, subjectId: d.dimension, category: "strength", engineVersion: "1.0.0",
      review: { observedPattern: answer === "insufficient" ? "UNCERTAIN" : answer === "not" ? "NO" : "YES",
                classificationAppropriate: answer === "supported" ? "YES" : answer === "partly" ? "PARTIALLY" : answer === "not" ? "NO" : "UNCERTAIN",
                evidenceSufficient: answer === "insufficient" ? "NO" : "YES", guidanceAppropriate: "UNCERTAIN", reason: null, notes: null, dataQuality: [] },
    }),
    onSuccess: async () => { toast({ kind: "success", title: t("strengths.confirmed") }); setAnswer(""); await onChanged(); },
    onError: (err: unknown) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast({ kind: "error", title: t(`intelReview.error.${code ?? "generic"}`, { defaultValue: t("intelReview.error.generic") }) });
    },
  });
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{t(`strengths.dimension.${d.dimension}`, { defaultValue: d.dimension })}</span>
        <Badge variant={d.state === "ESTABLISHED" ? "success" : d.state === "EMERGING" ? "info" : d.state === "DECLINING" ? "warning" : "default"} label={t(`strengths.state.${d.state}`)} />
        <Badge variant="default" label={t(`strengths.persistence.${d.persistence}`)} />
        <Badge variant={CONF_VARIANT[d.confidence]} label={t(`strengths.confidence.${d.confidence}`)} />
        {d.crossSubject && <Badge variant="default" label={t("strengths.crossSubject")} />}
      </div>
      <ul className="space-y-0.5 text-xs text-ink-muted">
        {d.evidence.map((e, i) => (
          <li key={i} className={e.supports ? "" : "text-warning"}>
            {e.evidenceType === "subject_performance" && t("strengths.ev.performance", { s: e.subjectName ?? e.subjectId, n: e.strongObservations, o: e.observations, p: t(`strengths.persistence.${e.persistence}`), c: e.consistency ? t(`strengths.consistency.${e.consistency}`) : "—", avg: e.overallAverage ?? "—" })}
            {e.evidenceType === "subject_decline" && t("strengths.ev.decline", { s: e.subjectName ?? e.subjectId, r: e.recentAverage ?? "—", d: e.delta ?? "—" })}
            {e.evidenceType === "cross_subject_support" && t("strengths.ev.cross", { n: e.subjectIds?.length ?? 0 })}
            {e.evidenceType === "teacher_observation" && t("strengths.ev.observation", { n: e.observers ?? 0 })}
          </li>
        ))}
      </ul>
      {d.limitations.length > 0 && <p className="text-xs text-ink-muted">{t("strengths.limits")}: {d.limitations.map((l) => t(`strengths.limitation.${l}`, { defaultValue: l })).join(", ")}</p>}
      {d.fused && (
        <p className="text-xs text-ink-muted">
          {t("strengths.fusion.line", { base: t(`strengths.state.${d.baseState ?? d.state}`), src: t(`strengths.fusion.source.${d.fused.stateSource}`),
            s: d.fused.supportingEvents, c: d.fused.contradictingEvents, o: d.fused.teacherObservers, stale: d.fused.recency.stale })}
          {d.fused.pair && ` · ${t("strengths.fusion.pair", { i: d.fused.pair.interest, p: d.fused.pair.performance })}`}
        </p>
      )}
      <Timeline dimension={d.dimension} />
      {isStaff && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
          <div className="text-xs text-ink-muted">{t("strengths.yourViewLabel")}</div>
          {mine.length > 0 ? (
            <span className="text-xs text-ink">{mine.map((m) => `${m.reviewedByName ?? m.reviewedBy}: ${t(`intelReview.answer.${m.review.classificationAppropriate}`)}`).join(" · ")}</span>
          ) : (
            <>
              <SelectField value={answer} onChange={(e) => setAnswer(e.target.value)}
                options={[{ value: "", label: t("intelReview.answer.choose") }, ...["supported", "partly", "not", "insufficient"].map((v) => ({ value: v, label: t(`strengths.confirm.${v}`) }))]} />
              <Button size="sm" variant="secondary" disabled={!answer || confirm.isPending} onClick={() => confirm.mutate()}>{t("strengths.confirmButton")}</Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function RecordEvidence({ studentId, schoolId, onChanged, toast }: { studentId: string; schoolId?: string; onChanged: () => Promise<unknown>; toast: ReturnType<typeof useToast>["toast"] }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ kind: "exposure", dimension: DIMENSIONS[0], activity: "", date: new Date().toISOString().slice(0, 10), participation: "took_part", outcome: "" });
  const m = useMutation({
    mutationFn: () => recordExplorationEvidence(studentId, { ...(schoolId ? { schoolId } : {}), kind: f.kind, dimension: f.dimension, activity: f.activity, date: f.date,
      participation: f.kind === "exposure" ? f.participation : undefined, outcome: f.outcome || undefined }),
    onSuccess: async () => { toast({ kind: "success", title: t("strengths.evidenceRecorded") }); setF((x) => ({ ...x, activity: "", outcome: "" })); await onChanged(); },
    onError: () => toast({ kind: "error", title: t("strengths.evidenceFailed") }),
  });
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-ink-muted">{t("strengths.recordHeading")}</summary>
      <p className="mt-1 text-xs text-ink-muted">{t("strengths.recordHint")}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <FormField label={t("strengths.form.kind")}>
          <SelectField value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))}
            options={["exposure", "performance", "teacher_observation"].map((k) => ({ value: k, label: t(`strengths.kind.${k}`) }))} />
        </FormField>
        <FormField label={t("strengths.form.dimension")}>
          <SelectField value={f.dimension} onChange={(e) => setF((x) => ({ ...x, dimension: e.target.value }))}
            options={DIMENSIONS.map((d) => ({ value: d, label: t(`strengths.dimension.${d}`) }))} />
        </FormField>
        <FormField label={t("strengths.form.date")}><Textarea rows={1} value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} /></FormField>
        <FormField label={t("strengths.form.activity")} required><Textarea rows={1} maxLength={200} value={f.activity} onChange={(e) => setF((x) => ({ ...x, activity: e.target.value }))} /></FormField>
        {f.kind === "exposure" && (
          <FormField label={t("strengths.form.participation")}>
            <SelectField value={f.participation} onChange={(e) => setF((x) => ({ ...x, participation: e.target.value }))}
              options={["attended", "took_part", "led", "completed", "did_not_complete"].map((k) => ({ value: k, label: t(`strengths.participation.${k}`) }))} />
          </FormField>
        )}
        <FormField label={t("strengths.form.outcome")}><Textarea rows={1} maxLength={500} value={f.outcome} onChange={(e) => setF((x) => ({ ...x, outcome: e.target.value }))} /></FormField>
      </div>
      <Button size="sm" variant="secondary" disabled={!f.activity.trim() || m.isPending} onClick={() => m.mutate()}>{t("strengths.recordButton")}</Button>
      <span className="ml-3 text-xs text-ink-muted">{AREAS.length ? "" : ""}</span>
    </details>
  );
}

function SnapshotButton({ studentId, schoolId, onChanged, toast }: { studentId: string; schoolId?: string; onChanged: () => Promise<unknown>; toast: ReturnType<typeof useToast>["toast"] }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  void snapshotStrengthProfile;
  const m = useMutation({
    // Rebuild: idempotent on the evidence boundary — unchanged evidence returns the snapshot that already covers it.
    mutationFn: () => rebuildProfile(studentId, { ...(schoolId ? { schoolId } : {}), periodLabel: label || undefined }),
    onSuccess: async (r) => { toast({ kind: r.created ? "success" : "info", title: t(r.created ? "strengths.snapshotTaken" : "strengths.fusion.nothingNew") }); setLabel(""); await onChanged(); },
    onError: () => toast({ kind: "error", title: t("strengths.snapshotFailed") }),
  });
  return (
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <FormField label={t("strengths.form.periodLabel")}><Textarea rows={1} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} /></FormField>
      <Button size="sm" variant="secondary" disabled={m.isPending} onClick={() => m.mutate()}>{t("strengths.snapshotButton")}</Button>
    </div>
  );
}

/**
 * The pupil's explorations, for staff: status, the pair, the reflection as the
 * pupil allowed it, observations and ratings — with the forms to add one.
 */
function Explorations({ studentId, schoolId, toast, onChanged }: { studentId: string; schoolId?: string; toast: ReturnType<typeof useToast>["toast"]; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["explorations", studentId, schoolId], queryFn: () => fetchExplorations(studentId, schoolId) });
  const catalogQ = useQuery({ queryKey: ["exploration-catalog", schoolId], queryFn: () => fetchCatalog(schoolId), staleTime: 300_000 });
  const criteriaOf = (activityId: string) => catalogQ.data?.find((a) => a.activityId === activityId)?.performanceCriteria ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["explorations", studentId] }); await onChanged(); };
  const rows = q.data?.explorations ?? [];
  return (
    <Section icon={<Route className="h-3.5 w-3.5" />} heading={t("explore.staffHeading")} hint={t("explore.staffHint")}>
      {q.isLoading && <PageSpinner />}
      {!q.isLoading && !rows.length && <p className="text-sm text-ink-muted">{t("explore.none")}</p>}
      {rows.map((e) => <ExplorationCard key={e.explorationId} e={e} criteria={criteriaOf(e.activityId)} schoolId={schoolId} toast={toast} onChanged={refresh} />)}
    </Section>
  );
}

function ExplorationCard({ e, criteria, schoolId, toast, onChanged }: { e: ExplorationRow; criteria: string[]; schoolId?: string; toast: ReturnType<typeof useToast>["toast"]; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [obs, setObs] = useState<{ level: string; codes: string[]; note: string }>({ level: "OBSERVED", codes: [], note: "" });
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const fail = (err: unknown) => {
    const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
    toast({ kind: "error", title: t(`explore.error.${code ?? "generic"}`, { defaultValue: t("explore.error.generic") }) });
  };
  const observe = useMutation({
    mutationFn: () => observeExploration(e.explorationId, { ...(schoolId ? { schoolId } : {}), level: obs.level, codes: obs.codes, note: obs.note || undefined }),
    onSuccess: async () => { toast({ kind: "success", title: t("explore.observed") }); await onChanged(); }, onError: fail,
  });
  const rate = useMutation({
    mutationFn: () => rateExploration(e.explorationId, { ...(schoolId ? { schoolId } : {}), version: e.version,
      ratings: Object.entries(ratings).filter(([, r]) => r).map(([criterion, rating]) => ({ criterion, rating })) }),
    onSuccess: async () => { toast({ kind: "success", title: t("explore.rated") }); await onChanged(); }, onError: fail,
  });
  const canRate = criteria.length > 0 && ["SUBMITTED", "REVIEW_REQUIRED"].includes(e.status);
  const closedish = ["COMPLETED", "ABANDONED", "SKIPPED", "NOT_INTERESTED"].includes(e.status);
  return (
    <Card className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{e.title}</span>
        <Badge variant={e.status === "COMPLETED" ? "success" : e.status === "REVIEW_REQUIRED" ? "warning" : closedish ? "default" : "info"} label={t(`explore.status.${e.status}`)} />
        <Badge variant="default" label={t(`strengths.area.${e.area}`, { defaultValue: e.area })} />
        <span className="text-xs text-ink-muted">{t(`explore.level.${e.level}`)}{e.relevance ? ` · ${t(`explore.relevance.${e.relevance}`)}` : ""}</span>
      </div>
      {e.suggestedBecause.length > 0 && <p className="text-xs text-ink-muted">{t("explore.because")}: {e.suggestedBecause.map((r) => t(`explore.reason.${r}`, { defaultValue: r })).join(", ")}</p>}
      {e.outputs && e.outputs.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-ink">{e.outputs.map((o, i) => <li key={i}><span className="text-ink-muted">{o.label}: </span>{o.value}</li>)}</ul>
      )}
      {e.reflection && (
        <p className="text-xs text-ink">
          <span className="text-ink-muted">{t("explore.reflection")}: </span>
          {[e.reflection.interest && t("explore.interest", { v: t(`explore.scale.${e.reflection.interest}`) }),
            e.reflection.difficulty && t("explore.difficulty", { v: t(`explore.scale.${e.reflection.difficulty}`) }),
            e.reflection.continue && t("explore.continue", { v: t(`explore.scale.${e.reflection.continue}`) })].filter(Boolean).join(" · ")}
          {e.reflection.enjoyed !== undefined ? ` — "${e.reflection.enjoyed ?? ""}"` : ` · ${t("explore.textPrivate")}`}
        </p>
      )}
      {e.pattern.pattern && <p className="text-xs text-ink-muted">{t("explore.pair")}: {t(`explore.scale.${e.pattern.interest}`)} {t("explore.pairInterest")} · {t(`explore.perfLevel.${e.pattern.performance}`)} {t("explore.pairPerformance")}</p>}
      <p className="text-xs text-ink-muted">{t("explore.evidence")}: {e.evidence.length ? e.evidence.map((v) => t(`strengths.kind.${v.kind}`, { defaultValue: v.kind })).join(", ") : "—"}</p>
      {e.observations.map((o) => (
        <p key={o.observationId} className="text-xs text-ink"><span className="text-ink-muted">{t("explore.observationBy", { who: o.observedBy })}: </span>{t(`explore.obsLevel.${o.level}`)} · {o.codes.map((c) => t(`explore.obsCode.${c}`)).join(", ")}{o.note ? ` — ${o.note}` : ""}</p>
      ))}
      {e.performance && <p className="text-xs text-ink"><span className="text-ink-muted">{t("explore.ratedBy", { who: e.performance.ratedBy })}: </span>{t(`explore.perfLevel.${e.performance.level}`)} · {e.performance.ratings.map((r) => `${t(`explore.criterion.${r.criterion}`)} ${t(`explore.rating.${r.rating}`)}`).join(", ")}</p>}

      {["STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(e.status) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">{t("explore.observeHeading")}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <FormField label={t("explore.obsLevelLabel")}>
              <SelectField value={obs.level} onChange={(ev) => setObs((o) => ({ ...o, level: ev.target.value }))} options={OBS_LEVELS.map((l) => ({ value: l, label: t(`explore.obsLevel.${l}`) }))} />
            </FormField>
            <FormField label={t("explore.obsNote")}><Textarea rows={1} maxLength={1000} value={obs.note} onChange={(ev) => setObs((o) => ({ ...o, note: ev.target.value }))} /></FormField>
          </div>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {OBS_CODES.map((c) => (
              <Checkbox key={c} label={t(`explore.obsCode.${c}`)} checked={obs.codes.includes(c)}
                onChange={(ev) => setObs((o) => ({ ...o, codes: ev.target.checked ? [...o.codes, c] : o.codes.filter((x) => x !== c) }))} />
            ))}
          </div>
          <Button size="sm" variant="secondary" disabled={observe.isPending} onClick={() => observe.mutate()}>{t("explore.observeButton")}</Button>
        </details>
      )}
      {canRate && (
        <details className="text-xs" open>
          <summary className="cursor-pointer text-ink-muted">{t("explore.rateHeading")}</summary>
          <p className="mt-1 text-ink-muted">{t("explore.rateHint")}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {criteria.map((c) => (
              <FormField key={c} label={t(`explore.criterion.${c}`)}>
                <SelectField value={ratings[c] ?? ""} onChange={(ev) => setRatings((r) => ({ ...r, [c]: ev.target.value }))}
                  options={[{ value: "", label: t("intelReview.answer.choose") }, ...RATINGS.map((r) => ({ value: r, label: t(`explore.rating.${r}`) }))]} />
              </FormField>
            ))}
          </div>
          <Button size="sm" variant="primary" disabled={rate.isPending || !Object.values(ratings).some(Boolean)} onClick={() => rate.mutate()}>{t("explore.rateButton")}</Button>
        </details>
      )}
    </Card>
  );
}

/** What changed since the last snapshot: the new evidence, the moved dimensions, the reasons. */
function WhatChanged({ studentId, schoolId }: { studentId: string; schoolId?: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["profile-changes", studentId, schoolId], queryFn: () => fetchProfileChanges(studentId, schoolId) });
  const c = q.data;
  if (!c?.comparison) return null;
  const moved: Array<[string, ChangeEntry[]]> = [["newStrengths", c.comparison.newStrengths], ["newEmerging", c.comparison.newEmerging], ["strengthened", c.comparison.strengthened], ["weakened", c.comparison.weakened], ["declining", c.comparison.declining]];
  const any = moved.some(([, l]) => l.length) || (c.newEvidence?.rows ?? 0) > 0;
  return (
    <Section icon={<GitCompare className="h-3.5 w-3.5" />} heading={t("strengths.fusion.changesHeading")}
      hint={c.previous ? t("strengths.fusion.changesSince", { v: c.previous.profileVersion, when: new Date(c.previous.generatedAt).toLocaleDateString() }) : t("strengths.fusion.noSnapshotYet")}>
      {!any && <p className="text-sm text-ink-muted">{t("strengths.fusion.nothingChanged")}</p>}
      {c.newEvidence && c.newEvidence.rows > 0 && (
        <p className="text-sm text-ink">{t("strengths.fusion.newEvidence")}: {Object.entries(c.newEvidence.byKind).map(([k, v]) => `${v} × ${t(`strengths.kind.${k}`, { defaultValue: k })}`).join(", ")} · {t("strengths.fusion.explorations", { n: c.newEvidence.explorations })}</p>
      )}
      {moved.filter(([, l]) => l.length).map(([k, l]) => (
        <div key={k}>
          <p className="text-xs font-medium text-ink-faint">{t(`strengths.fusion.moved.${k}`)}</p>
          <ul className="list-disc pl-5 text-sm text-ink">
            {l.map((e) => (
              <li key={e.dimension}>
                {t(`strengths.dimension.${e.dimension}`, { defaultValue: e.dimension })}: {t(`strengths.state.${e.previous.state}`)} → {t(`strengths.state.${e.current.state}`)}
                {e.previous.confidence !== e.current.confidence && ` (${t(`strengths.confidence.${e.previous.confidence}`)} → ${t(`strengths.confidence.${e.current.confidence}`)})`}
                {e.reasons.length > 0 && <span className="text-xs text-ink-muted"> — {e.reasons.map((r) => t(`strengths.fusion.reason.${r.split(":")[0]}`, { defaultValue: r, n: r.split(":")[1] ?? "" })).join("; ")}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {c.pendingSnapshot && <p className="text-xs text-ink-muted">{t("strengths.fusion.pending")}</p>}
    </Section>
  );
}

/** The dimension's timeline, collapsed: academic periods, events by date, the reading. */
function Timeline({ dimension }: { dimension: string }) {
  const { t } = useTranslation();
  const { studentId = "" } = useParams();
  const user = useUser();
  const schoolId = user?.role === "super_admin" ? (user?.schoolId || undefined) : undefined;
  const q = useQuery({ queryKey: ["strengths", studentId, schoolId], queryFn: () => fetchStrengths(studentId, schoolId), enabled: false });
  const rows = q.data?.profile?.fusion?.timeline?.[dimension] ?? [];
  if (!rows.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-ink-muted">{t("strengths.fusion.timeline")}</summary>
      <ul className="mt-1 space-y-0.5 text-ink-muted">
        {rows.map((r, i) => (
          <li key={i}>
            {r.when ? (r.when.length > 10 ? new Date(r.when).toLocaleDateString() : r.when) : "—"} · {t(`strengths.fusion.src.${r.source.toLowerCase()}`, { defaultValue: r.source })} · {r.subjectName ?? ""}{r.area ? t(`strengths.area.${r.area}`, { defaultValue: r.area }) : ""} {r.reading}{r.observers ? ` ×${r.observers}` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One series reading, as a line: pattern, mean, events, recency. */
function SeriesLine({ label, s }: { label: string; s: SeriesReading }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1 text-sm">
      <span className="text-ink">{label}</span>
      <span className="text-right text-xs text-ink-muted">
        {t(`learning.pattern.${s.pattern}`, { defaultValue: s.pattern })}
        {s.mean !== null && ` · ${t("learning.mean", { v: Math.round(s.mean * 20 * 10) / 10 })}`}
        {` · ${t("learning.events", { n: s.independentEvents })}`}
        {s.stale > 0 && ` · ${t("learning.stale", { n: s.stale })}`}
      </span>
    </div>
  );
}

/**
 * The school's own records, per subject: assessment, CA, practical, quizzes,
 * homework (completion and submission apart from marks), attendance, the
 * patterns, the coverage, the conflicts, the timeline. Observed evidence,
 * system pattern and evidence limitation are three different columns here,
 * as they are everywhere else in this system.
 */
function LearningEvidence({ studentId, schoolId, isStaff, toast }: { studentId: string; schoolId?: string; isStaff: boolean; toast: ReturnType<typeof useToast>["toast"] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["learning-evidence", studentId, schoolId], queryFn: () => fetchLearningEvidence(studentId, schoolId) });
  const cq = useQuery({ queryKey: ["learning-changes", studentId, schoolId], queryFn: () => fetchLearningChanges(studentId, schoolId), enabled: isStaff });
  const rebuild = useMutation({
    mutationFn: () => rebuildLearningEvidence(studentId, schoolId),
    onSuccess: async (r) => { toast({ kind: r.created ? "success" : "info", title: t(r.created ? "learning.snapshotTaken" : "learning.nothingNew") }); await qc.invalidateQueries({ queryKey: ["learning-changes", studentId] }); },
    onError: () => toast({ kind: "error", title: t("learning.rebuildFailed") }),
  });
  const d = q.data;
  if (!d || !d.learningEvidenceVersion) return null;
  const subjects = Object.values(d.patterns.bySubject).filter((s) => s.subjectId);
  const att: AttendanceReading = d.patterns.attendance.overall;
  return (
    <Section icon={<BookOpen className="h-3.5 w-3.5" />} heading={t("learning.heading")} hint={t("learning.hint", { v: d.learningEvidenceVersion })}>
      <Card className="text-xs text-ink-muted">
        {t("learning.counts", { e: d.counts.events, h: d.counts.bySource.HOMEWORK ?? 0, q: d.counts.bySource.QUIZ ?? 0, s: d.counts.bySource.EXAM_SCORE ?? 0, a: d.counts.bySource.ATTENDANCE ?? 0 })}
        {" · "}{t("learning.coverageOverall")}: <Badge variant="default" label={t(`learning.quality.${d.quality.overall.level}`)} />
        {d.quality.overall.flags.map((f) => <span key={f}> <Badge variant="warning" label={t(`learning.flag.${f}`, { defaultValue: f })} /></span>)}
      </Card>

      {subjects.map((s: SubjectLearning) => {
        const qs = d.quality.subjects[s.subjectId ?? "__none__"];
        return (
          <Card key={s.subjectId ?? "none"} className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{s.subjectId}</span>
              <Badge variant="default" label={t(`learning.quality.${qs?.level ?? "NO_DATA"}`)} />
              {(qs?.flags ?? []).map((f) => <Badge key={f} variant="warning" label={t(`learning.flag.${f}`, { defaultValue: f })} />)}
            </div>
            <p className="text-xs font-medium text-ink-faint">{t("learning.observed")}</p>
            <SeriesLine label={t("learning.family.formal")} s={s.formal} />
            <SeriesLine label={t("learning.family.continuous")} s={s.continuous} />
            <SeriesLine label={t("learning.family.practical")} s={s.practical} />
            <SeriesLine label={t("learning.family.quiz")} s={s.quiz} />
            <SeriesLine label={t("learning.family.homeworkMarks")} s={s.homework.performance} />
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1">
              <span className="text-ink">{t("learning.family.homeworkCompletion")}</span>
              <span className="text-right text-xs text-ink-muted">
                {t(`learning.pattern.${s.homework.pattern}`, { defaultValue: s.homework.pattern })} · {t("learning.completedOf", { c: s.homework.completed, a: s.homework.assigned })}
                {s.homework.pending > 0 && ` · ${t("learning.pending", { n: s.homework.pending })}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1">
              <span className="text-ink">{t("learning.family.submission")}</span>
              <span className="text-right text-xs text-ink-muted">
                {t(`learning.pattern.${s.homework.submission.pattern}`, { defaultValue: s.homework.submission.pattern })} · {t("learning.submissionCounts", s.homework.submission)}
              </span>
            </div>
            {(qs?.contradictions ?? []).length > 0 && (
              <p className="text-xs text-warning">{t("learning.conflicts")}: {(qs?.contradictions ?? []).map((c) => t(`learning.contradiction.${c.code}`, { defaultValue: c.code })).join("; ")}</p>
            )}
          </Card>
        );
      })}

      <Card className="text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{t("learning.attendance")}</span>
          <Badge variant={att.pattern === "ATTENDANCE_STABLE" ? "success" : att.pattern === "INSUFFICIENT_ATTENDANCE_DATA" ? "default" : "warning"} label={t(`learning.pattern.${att.pattern}`)} />
        </div>
        <p className="text-xs text-ink-muted">{t("learning.attendanceCounts", { p: att.present, a: att.absent, l: att.late, e: att.excused, m: att.marked })}</p>
        <p className="text-xs text-ink-muted">{t("learning.attendanceNote")}</p>
      </Card>

      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted">{t("learning.timeline", { n: d.timeline.length })}</summary>
        <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto text-ink-muted">
          {d.timeline.slice().reverse().map((e) => (
            <li key={e.learningEventId}>{e.when ? new Date(e.when).toLocaleDateString() : "—"} · {t(`learning.source.${e.sourceType}`)}{e.subjectId ? ` · ${e.subjectId}` : ""} · {e.observations.map((o) => `${o.kind}: ${o.state}${o.normalizedValue !== undefined && o.normalizedValue !== null ? ` (${Math.round(o.normalizedValue * 100)}%)` : ""}`).join(", ")} · {e.recency}</li>
          ))}
        </ul>
      </details>

      <p className="text-xs text-ink-muted">{t("learning.notInferred")}</p>
      {isStaff && cq.data && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{cq.data.previous ? t("learning.lastSnapshot", { n: cq.data.previous.snapshotNumber, when: new Date(cq.data.previous.generatedAt).toLocaleDateString() }) : t("learning.noSnapshot")}{cq.data.pendingSnapshot ? ` · ${t("learning.pending2")}` : ""}</span>
          <Button size="sm" variant="secondary" disabled={rebuild.isPending} onClick={() => rebuild.mutate()}>{t("learning.rebuild")}</Button>
        </div>
      )}
    </Section>
  );
}

function Section({ icon, heading, hint, children }: { icon: React.ReactNode; heading: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">{icon} {heading}</h3>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      {children}
    </section>
  );
}
