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
import { Sparkles, Compass, EyeOff, TrendingDown, ShieldOff, History } from "lucide-react";

import { useUser }      from "@/store/auth.store";
import { PageHeader }   from "@/components/ui/PageHeader";
import { Card }         from "@/components/ui/Card";
import { Button }       from "@/components/ui/Button";
import { Badge }        from "@/components/ui/Badge";
import { PageSpinner }  from "@/components/ui/Spinner";
import { useToast }     from "@/components/ui/Toast";
import { FormField, Textarea, SelectField } from "@/components/ui/FormField";
import {
  fetchStrengths, fetchStrengthProfile, fetchStrengthEvidence, snapshotStrengthProfile, recordExplorationEvidence, submitReview,
  type DimensionReading, type RecordedReview,
} from "@/services/insights.service";

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
  const m = useMutation({
    mutationFn: () => snapshotStrengthProfile(studentId, { ...(schoolId ? { schoolId } : {}), periodLabel: label || undefined }),
    onSuccess: async () => { toast({ kind: "success", title: t("strengths.snapshotTaken") }); setLabel(""); await onChanged(); },
    onError: () => toast({ kind: "error", title: t("strengths.snapshotFailed") }),
  });
  return (
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <FormField label={t("strengths.form.periodLabel")}><Textarea rows={1} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} /></FormField>
      <Button size="sm" variant="secondary" disabled={m.isPending} onClick={() => m.mutate()}>{t("strengths.snapshotButton")}</Button>
    </div>
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
