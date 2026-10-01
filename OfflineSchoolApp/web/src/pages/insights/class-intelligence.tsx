// web/src/pages/insights/class-intelligence.tsx
//
// The teacher's loop, on one screen.
//
//   pick a class → see who needs looking at → open a pupil → read WHY
//   → choose an action → record it → move it along → record what happened
//   → see what the marks looked like before and after
//
// ── What this page deliberately is not ───────────────────────────────────────
//
// A dashboard. There are no charts, no scores, no rankings and no KPI tiles.
// The job is to get a teacher from "this child needs attention" to "here is the
// evidence, and here is what I did about it" in as few steps as possible, and
// every widget that is not on that path is a widget competing with it.
//
// ── Where the thinking happens ───────────────────────────────────────────────
//
// On the server. This file renders what the intelligence engine already decided
// and never recomputes a mark, a trend, a threshold or a lifecycle rule. The
// only rule it holds a copy of is NEXT_STATUSES, and that is used to hide dead
// buttons — the server still refuses an illegal move, and a 409 from it is the
// authority.
//
// ── Wording ──────────────────────────────────────────────────────────────────
//
// The server sends codes; every sentence on this page comes from the i18n
// catalogue, in English or French. That includes the before/after reading,
// which is phrased as an observation: "performance increased after", never
// "the intervention worked". The system has not established causality and must
// not imply it.

import { useState }                     from "react";
import { useNavigate }                  from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation }               from "react-i18next";
import {
  AlertTriangle, Sparkles, Eye, ChevronRight, Plus, ArrowRight,
} from "lucide-react";

import { useUser }      from "@/store/auth.store";
import { PageHeader }   from "@/components/ui/PageHeader";
import { Card }         from "@/components/ui/Card";
import { Select }       from "@/components/ui/Select";
import { Button }       from "@/components/ui/Button";
import { Badge }        from "@/components/ui/Badge";
import { Modal }        from "@/components/ui/Modal";
import { PageSpinner }  from "@/components/ui/Spinner";
import { useToast }     from "@/components/ui/Toast";
import { cn }           from "@/utils/cn";
import {
  fetchClassIntelligence, fetchStudentGuidance, fetchStaffClasses,
  type ClassStudentRow, type GuidanceItem, type GuidanceSummary,
} from "@/services/insights.service";
import {
  fetchStudentInterventions, createIntervention, updateIntervention,
  fetchOutcomeEvidence, NEXT_STATUSES,
  type Intervention, type InterventionStatus, type OutcomeCode,
} from "@/services/intervention.service";

const OUTCOMES: OutcomeCode[] = ["improved", "no_change", "further_support", "not_assessed"];

/** Loud for a child who is struggling, quiet for one who is doing well. */
const PRIORITY_VARIANT = {
  high:     "danger",
  moderate: "warning",
  low:      "default",
} as const;

const STATUS_VARIANT: Record<InterventionStatus, "info" | "warning" | "success" | "default"> = {
  planned:   "info",
  active:    "warning",
  completed: "success",
  cancelled: "default",
};

// The class picker: a teacher's assignments, an administrator's school, an
// operator's selected school — fetchStaffClasses in the service decides.
// Asking the teacher roster for an administrator answered "none" and this
// page told a principal they were not assigned to any class.

export default function ClassIntelligencePage() {
  const { t }    = useTranslation();
  const { toast } = useToast();
  const qc       = useQueryClient();
  const user     = useUser();

  const [classId, setClassId] = useState("");
  const [openStudent, setOpenStudent] = useState<ClassStudentRow | null>(null);

  const isOperator = user?.role === "super_admin";
  const isAdmin    = isOperator || user?.role === "school_admin";
  // The operator reads the school they have selected (mirrored into
  // user.schoolId by the auth store). No selection is no school, not all.
  const blocked    = isOperator && !user?.schoolId;

  const classesQ = useQuery({
    queryKey: ["staff-classes", user?.role ?? "", user?.schoolId ?? ""],
    queryFn:  () => fetchStaffClasses(user),
    enabled:  !blocked,
  });

  // Default to the first class, so the screen is useful on arrival rather
  // than asking a question before showing anything.
  const classes = classesQ.data ?? [];
  const activeClassId = classId || classes[0]?._id || "";

  const classQ = useQuery({
    queryKey: ["class-intelligence", activeClassId],
    queryFn:  () => fetchClassIntelligence(activeClassId),
    enabled:  !!activeClassId,
    // The whole class is one aggregation over published results; it does not
    // change while somebody works through the list.
    staleTime: 60_000,
  });

  if (classesQ.isLoading) return <PageSpinner />;

  // Three different facts, three different sentences: the operator has not
  // selected a school; the school has no classes; the teacher holds no
  // assignment. An administrator is never told they are "not assigned".
  if (blocked || !classes.length) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("classIntel.title")} description={t("classIntel.blurb")} />
        <Card><p className="text-sm text-ink-muted">{t(blocked ? "intelReview.selectSchool" : isAdmin ? "classIntel.noClassesSchool" : "classIntel.noClasses")}</p></Card>
      </div>
    );
  }

  const data = classQ.data;
  const rows = data?.students ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title={t("classIntel.title")} description={t("classIntel.blurb")} />

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full sm:max-w-xs">
            <label className="mb-1 block text-xs font-medium text-ink-faint"
                   htmlFor="class-intel-picker">
              {t("classIntel.class")}
            </label>
            <Select
              id="class-intel-picker"
              className="w-full"
              value={activeClassId}
              onChange={(e) => setClassId(e.target.value)}
              options={classes.map((c) => ({ value: c._id, label: c.name }))}
            />
          </div>
          {data && (
            <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
              <Badge variant="default" label={t("classIntel.countStudents", { n: data.counts.students })} />
              <Badge variant="danger"  label={t("classIntel.countAttention", { n: data.counts.withRisk })} />
              <Badge variant="success" label={t("classIntel.countStrength", { n: data.counts.withStrength })} />
            </div>
          )}
        </div>
      </Card>

      {/* The offline/stale case: react-query keeps the last good answer, and
          saying so is the difference between old intelligence and wrong
          intelligence. */}
      {classQ.isError && (
        <Card className="ring-warning-line">
          <p className="text-sm text-warning">{t("classIntel.stale")}</p>
        </Card>
      )}

      {classQ.isLoading && <PageSpinner />}

      {!classQ.isLoading && !rows.length && (
        <Card><p className="text-sm text-ink-muted">{t("classIntel.empty")}</p></Card>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((row) => (
          <StudentCard key={row.studentId} row={row} onOpen={() => setOpenStudent(row)} />
        ))}
      </div>

      {openStudent && (
        <StudentPanel
          row={openStudent}
          classId={activeClassId}
          onClose={() => setOpenStudent(null)}
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: ["class-intelligence", activeClassId] });
          }}
          toast={toast}
          canAssign={user?.role !== "student"}
        />
      )}
    </div>
  );
}

/**
 * One pupil in the list.
 *
 * Shows the guidance areas and anything already open, and nothing else. Marks,
 * averages and positions are deliberately absent: this list answers "who should
 * I look at", and the answer to "why" is one tap away.
 */
function StudentCard({ row, onOpen }: { row: ClassStudentRow; onOpen: () => void }) {
  const { t } = useTranslation();
  const support  = row.guidance.filter((g) => g.type === "academic_support");
  const strength = row.guidance.filter((g) => g.type === "strength_development");

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.name ?? row.studentId}</p>
          {row.enrollmentNo && (
            <p className="text-xs text-ink-faint">{row.enrollmentNo}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          {t("classIntel.review")} <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>

      {!row.guidance.length && (
        <p className="text-xs text-ink-faint">{t("classIntel.nothingToNote")}</p>
      )}

      {support.length > 0 && (
        <GuidanceRow icon={<AlertTriangle className="h-4 w-4 text-danger" />} items={support} />
      )}
      {strength.length > 0 && (
        <GuidanceRow icon={<Sparkles className="h-4 w-4 text-success" />} items={strength} />
      )}
      {row.guidance.some((g) => g.type === "monitoring") && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <Eye className="h-4 w-4" />
          <span>{t("guidance.INSUFFICIENT_ACADEMIC_EVIDENCE")}</span>
        </div>
      )}

      {row.openInterventions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
          {row.openInterventions.map((i) => (
            <Badge
              key={i._id}
              variant={STATUS_VARIANT[i.status]}
              label={`${t(`intervention.status.${i.status}`)} · ${t(`guidance.${i.actionCode}`)}`}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function GuidanceRow({ icon, items }: { icon: React.ReactNode; items: GuidanceSummary[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((g, i) => (
          <Badge
            key={`${g.subjectId}-${g.rationaleCode}-${i}`}
            variant={PRIORITY_VARIANT[g.priority]}
            label={g.subjectName ? `${g.subjectName} · ${t(`guidance.${g.rationaleCode}`)}`
                                 : t(`guidance.${g.rationaleCode}`)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One pupil, in full: the evidence, then the actions, then what was done.
 *
 * This is where the human decision happens, and it is deliberately explicit —
 * the teacher picks an action from the ones the guidance suggests, and nothing
 * is created until they press the button.
 */
function StudentPanel({
  row, classId, onClose, onChanged, toast, canAssign,
}: {
  row: ClassStudentRow;
  classId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  toast: ReturnType<typeof useToast>["toast"];
  canAssign: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const guidanceQ = useQuery({
    queryKey: ["student-guidance", row.studentId],
    queryFn:  () => fetchStudentGuidance(row.studentId),
  });
  const listQ = useQuery({
    queryKey: ["student-interventions", row.studentId],
    queryFn:  () => fetchStudentInterventions(row.studentId),
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["student-interventions", row.studentId] }),
      onChanged(),
    ]);
  };

  const create = useMutation({
    mutationFn: createIntervention,
    onSuccess: async () => {
      toast({ kind: "success", title: t("intervention.created") });
      await refresh();
    },
    onError: () => toast({ kind: "error", title: t("intervention.createFailed") }),
  });

  const advance = useMutation({
    mutationFn: (p: { id: string; version: number; status?: InterventionStatus;
                      outcomeCode?: OutcomeCode }) =>
      updateIntervention(p.id, {
        version: p.version,
        ...(p.status ? { status: p.status } : {}),
        ...(p.outcomeCode ? { outcomeCode: p.outcomeCode } : {}),
      }),
    onSuccess: async () => {
      toast({ kind: "success", title: t("intervention.updated") });
      await refresh();
    },
    // 409 is the ordinary case, not a bug: somebody else's device got there
    // first. The list is refetched so the teacher sees the current state.
    onError: async () => {
      toast({ kind: "warning", title: t("intervention.conflict") });
      await refresh();
    },
  });

  return (
    <Modal open onClose={onClose} size="lg" title={row.name ?? row.studentId}>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">

        {/* ── Why am I seeing this? ───────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {t("classIntel.evidenceHeading")}
          </h3>
          {guidanceQ.isLoading && <PageSpinner />}
          {(guidanceQ.data?.guidance ?? []).map((item, i) => (
            <GuidanceCard
              key={`${item.rationaleCode}-${item.subjectId}-${i}`}
              item={item}
              busy={create.isPending}
              onChoose={(actionCode) => create.mutate({
                studentId:  row.studentId,
                sourceType: "guidance",
                sourceCode: item.rationaleCode,
                subjectId:  item.subjectId,
                actionCode,
              })}
            />
          ))}
          {!guidanceQ.isLoading && !(guidanceQ.data?.guidance ?? []).length && (
            <p className="text-sm text-ink-muted">{t("classIntel.nothingToNote")}</p>
          )}
        </section>

        {/* ── What was done ───────────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {t("intervention.heading")}
          </h3>
          {listQ.isLoading && <PageSpinner />}
          {!(listQ.data ?? []).length && !listQ.isLoading && (
            <p className="text-sm text-ink-muted">{t("intervention.none")}</p>
          )}
          {(listQ.data ?? []).map((item) => (
            <InterventionCard
              key={item._id}
              item={item}
              busy={advance.isPending}
              onAdvance={(status) =>
                advance.mutate({ id: item._id, version: item.version, status })}
              onOutcome={(outcomeCode) =>
                advance.mutate({ id: item._id, version: item.version, outcomeCode })}
            />
          ))}
        </section>
      </div>

      <div className="mt-4 flex justify-end border-t border-line pt-4">
        <Button variant="ghost" onClick={() => { onClose(); navigate(`/students/${row.studentId}/strengths`); }}>{t("strengths.openFromClass")}</Button>
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
      </div>
      {/* canAssign is reserved for the assignee picker; the server validates it. */}
      <span className="hidden" aria-hidden>{String(canAssign)}{classId}</span>
    </Modal>
  );
}

/** One guidance item: the reason, the numbers behind it, and the choices. */
function GuidanceCard({
  item, busy, onChoose,
}: { item: GuidanceItem; busy: boolean; onChoose: (actionCode: string) => void }) {
  const { t } = useTranslation();

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {item.subjectName && (
          <span className="font-medium text-ink">{item.subjectName}</span>
        )}
        <Badge variant={PRIORITY_VARIANT[item.priority]}
               label={t(`guidance.${item.rationaleCode}`)} />
        <Badge variant="secondary" label={t(`confidence.${item.confidence}`)} />
      </div>

      {/* The evidence, exactly as the engine reported it. Nothing is derived
          here — a second calculation in the browser is how a screen comes to
          disagree with the report card. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {item.evidence.map((e) => (
          <div key={e.metric}>
            <dt className="text-ink-faint">{t(`evidence.${e.metric}`, e.metric)}</dt>
            <dd className="tabular text-ink">
              {typeof e.value === "number" && e.scale
                ? `${e.value}/${e.scale}`
                : typeof e.value === "string"
                  ? t(`evidence.value.${e.value}`, e.value)
                  : e.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* The human decision. Nothing is pre-selected and nothing is submitted
          until a teacher chooses. */}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {item.recommendedActionCodes.map((code) => (
          <Button key={code} variant="secondary" size="sm" disabled={busy}
                  onClick={() => onChoose(code)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t(`guidance.${code}`)}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/** One recorded action, its lifecycle buttons, and its before/after evidence. */
function InterventionCard({
  item, busy, onAdvance, onOutcome,
}: {
  item: Intervention;
  busy: boolean;
  onAdvance: (status: InterventionStatus) => void;
  onOutcome: (outcome: OutcomeCode) => void;
}) {
  const { t } = useTranslation();
  const [showEvidence, setShowEvidence] = useState(false);

  const evidenceQ = useQuery({
    queryKey: ["intervention-evidence", item._id, item.version],
    queryFn:  () => fetchOutcomeEvidence(item._id),
    enabled:  showEvidence,
  });

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[item.status]}
               label={t(`intervention.status.${item.status}`)} />
        <span className="text-sm text-ink">{t(`guidance.${item.actionCode}`)}</span>
        {item.sourceCode && (
          <span className="text-xs text-ink-faint">
            {t("intervention.from", { reason: t(`guidance.${item.sourceCode}`) })}
          </span>
        )}
      </div>

      {item.notes && <p className="text-xs text-ink-muted">{item.notes}</p>}

      <div className="flex flex-wrap gap-2">
        {NEXT_STATUSES[item.status].map((next) => (
          <Button key={next} variant={next === "cancelled" ? "ghost" : "secondary"}
                  size="sm" disabled={busy} onClick={() => onAdvance(next)}>
            {t(`intervention.move.${next}`)}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setShowEvidence((v) => !v)}>
          {t("intervention.showEvidence")}
        </Button>
      </div>

      {/* Outcome: the teacher's own judgement, recorded as theirs. The system
          offers the vocabulary and does not choose within it. */}
      {item.status === "completed" && !item.outcomeCode && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <span className="w-full text-xs text-ink-faint">{t("intervention.outcomePrompt")}</span>
          {OUTCOMES.map((code) => (
            <Button key={code} variant="secondary" size="sm" disabled={busy}
                    onClick={() => onOutcome(code)}>
              {t(`intervention.outcome.${code}`)}
            </Button>
          ))}
        </div>
      )}
      {item.outcomeCode && (
        <p className="text-xs text-ink-muted">
          {t("intervention.outcomeRecorded", {
            outcome: t(`intervention.outcome.${item.outcomeCode}`),
          })}
        </p>
      )}

      {showEvidence && (
        <div className="space-y-2 border-t border-line pt-3">
          {evidenceQ.isLoading && <PageSpinner />}
          {evidenceQ.data && <EvidenceComparison ev={evidenceQ.data} />}
        </div>
      )}
    </Card>
  );
}

/**
 * Before and after — an observation, never a verdict.
 *
 * The reading code is rendered from the catalogue and every one of them is
 * phrased neutrally. The page must not say the intervention worked: the system
 * has not established causality, and the note below says so in the reader's
 * language rather than leaving them to assume otherwise.
 */
function EvidenceComparison({ ev }: { ev: Awaited<ReturnType<typeof fetchOutcomeEvidence>> }) {
  const { t } = useTranslation();

  if (ev.status !== "compared") {
    return <p className="text-xs text-ink-muted">{t(`evidence.reading.${ev.reading}`)}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-faint">{ev.subjectName}</span>
        <span className="tabular text-ink">
          {t("evidence.before")}: {ev.before?.average}/{ev.scale}
        </span>
        <ArrowRight className="h-4 w-4 text-ink-faint" />
        <span className="tabular text-ink">
          {t("evidence.after")}: {ev.after?.average}/{ev.scale}
        </span>
        <span className={cn("tabular font-medium",
          (ev.change ?? 0) > 0 ? "text-success" : (ev.change ?? 0) < 0 ? "text-danger" : "text-ink-muted")}>
          {(ev.change ?? 0) > 0 ? "+" : ""}{ev.change}
        </span>
      </div>
      <p className="text-xs text-ink-muted">{t(`evidence.reading.${ev.reading}`)}</p>
      <p className="text-xs text-ink-faint">{t("evidence.notCausal")}</p>
    </div>
  );
}
