// web/src/pages/promotion/index.tsx
//
// End-of-year rollover: generate → review → commit.
//
// This is the most destructive thing the console can do — it rewrites the class
// of every student at once — so it is built as a proposal that a person reads
// before anything moves, and every row shows WHY it says what it says. A review
// screen of 500 identical rows can only be trusted blindly, which is the same as
// having no review step.
//
// A student with no destination is "unassigned", and the commit refuses to run
// while any remain. That is deliberate: the alternative is guessing.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play, ChevronLeft, AlertTriangle, Info } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Badge }       from "@/components/ui/Badge";
import { Modal }       from "@/components/ui/Modal";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { useToast }    from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { cn }              from "@/utils/cn";
import { getErrorMessage } from "@/lib/api";
import {
  fetchRuns, fetchRun, generateRun, setDecision,
  commitRun, reverseRun, discardRun, fetchProgression,
} from "@/services/promotion.service";
import type {
  Outcome, RunStatus, PromotionDecision,
} from "@/types/promotion.types";

const STATUS_VARIANT: Record<RunStatus, "warning" | "success" | "default"> = {
  draft:     "warning",
  committed: "success",
  reversed:  "default",
};

const OUTCOME_VARIANT: Record<Outcome, "success" | "warning" | "info" | "danger"> = {
  promoted:   "success",
  repeated:   "warning",
  graduated:  "info",
  unassigned: "danger",
};

/** Cameroonian school years run September–July. */
const yearPair = () => {
  const now   = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    from: `${start}/${start + 1}`,
    to:   `${start + 1}/${start + 2}`,
  };
};

export default function PromotionPage() {
  const { t }    = useTranslation();
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [genOpen, setGenOpen]         = useState(false);
  const [commitOpen, setCommitOpen]   = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [editing, setEditing] = useState<PromotionDecision | null>(null);

  const defaults = yearPair();
  const [years, setYears] = useState({ from: defaults.from, to: defaults.to });
  const [reason, setReason] = useState("");
  const [edit, setEdit] = useState<{ outcome: Outcome; toClassId: string }>({
    outcome: "promoted", toClassId: "",
  });

  const runsQ = useQuery({
    queryKey: ["promotion", "runs", schoolId],
    queryFn:  () => fetchRuns(schoolId),
    enabled:  !!schoolId,
  });

  const detailQ = useQuery({
    queryKey: ["promotion", "runs", schoolId, selectedId],
    queryFn:  () => fetchRun(selectedId as string, schoolId),
    enabled:  !!schoolId && !!selectedId,
  });

  const progQ = useQuery({
    queryKey: ["promotion", "progression", schoolId],
    queryFn:  () => fetchProgression(schoolId),
    enabled:  !!schoolId,
  });

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["promotion"] }); };

  const generateMutation = useMutation({
    mutationFn: () => generateRun(schoolId, years.from, years.to),
    onSuccess: (res) => {
      setGenOpen(false);
      invalidate();
      setSelectedId(res.run._id);
    },
    onError: (err) =>
      toast({ kind: "error", title: t("promo.newRun"), message: getErrorMessage(err) }),
  });

  const decisionMutation = useMutation({
    mutationFn: () =>
      setDecision(
        selectedId as string,
        editing?.studentId as string,
        schoolId,
        edit.outcome,
        edit.outcome === "graduated" ? null : edit.toClassId || null
      ),
    onSuccess: () => { setEditing(null); invalidate(); },
    onError: (err) =>
      toast({ kind: "error", title: t("promo.change"), message: getErrorMessage(err) }),
  });

  const commitMutation = useMutation({
    mutationFn: () => commitRun(selectedId as string, schoolId),
    onSuccess: () => {
      toast({ kind: "success", title: t("promo.committedToast") });
      setCommitOpen(false);
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("promo.commit"), message: getErrorMessage(err) }),
  });

  const reverseMutation = useMutation({
    mutationFn: () => reverseRun(selectedId as string, schoolId, reason.trim()),
    onSuccess: () => {
      toast({ kind: "success", title: t("promo.reversedToast") });
      setReverseOpen(false);
      setReason("");
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("promo.reverse"), message: getErrorMessage(err) }),
  });

  const discardMutation = useMutation({
    mutationFn: () => discardRun(selectedId as string, schoolId),
    onSuccess: () => { setSelectedId(null); invalidate(); },
    onError: (err) =>
      toast({ kind: "error", title: t("promo.discard"), message: getErrorMessage(err) }),
  });

  if (runsQ.isLoading) return <PageSpinner />;

  const runs    = runsQ.data ?? [];
  const classes = progQ.data?.data ?? [];

  const openEditor = (d: PromotionDecision) => {
    setEditing(d);
    setEdit({
      outcome:   d.outcome === "unassigned" ? "promoted" : d.outcome,
      toClassId: d.toClassId ?? "",
    });
  };

  const askDiscard = async () => {
    const ok = await confirm({
      title:        t("promo.discardTitle"),
      message:      t("promo.discardBody"),
      confirmLabel: t("promo.discard"),
      kind:         "danger",
    });
    if (ok) discardMutation.mutate();
  };

  // ── Detail ─────────────────────────────────────────────────────────────────
  if (selectedId) {
    const run       = detailQ.data?.run;
    const decisions = detailQ.data?.decisions ?? [];
    const blocked   = run?.counts.unassigned ?? 0;

    return (
      <div className="space-y-5">
        <PageHeader
          title={run ? `${run.fromYear} → ${run.toYear}` : t("promo.title")}
          description={run ? t(`promo.${run.status}`) : undefined}
          actions={
            <>
              <Button
                variant="ghost"
                icon={<ChevronLeft className="h-4 w-4" />}
                onClick={() => setSelectedId(null)}
              >
                {t("common.back")}
              </Button>
              {run?.status === "draft" && (
                <>
                  <Button variant="secondary" onClick={askDiscard}>
                    {t("promo.discard")}
                  </Button>
                  <Button disabled={blocked > 0} onClick={() => setCommitOpen(true)}>
                    {t("promo.commit")}
                  </Button>
                </>
              )}
              {run?.status === "committed" && (
                <Button variant="danger" onClick={() => setReverseOpen(true)}>
                  {t("promo.reverse")}
                </Button>
              )}
            </>
          }
        />

        {detailQ.isLoading || !run ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <>
            {run.status === "draft" && blocked === 0 && (
              <div className="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink-body">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <p>{t("promo.draftNotice")}</p>
              </div>
            )}

            {blocked > 0 && (
              <div className="flex items-start gap-2 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{t("promo.blockedNotice", { count: blocked })}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([
                ["promo.promoted",   run.counts.promoted],
                ["promo.repeated",   run.counts.repeated],
                ["promo.graduated",  run.counts.graduated],
                ["promo.unassigned", run.counts.unassigned],
              ] as const).map(([key, value]) => (
                <Card key={key}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {t(key)}
                  </p>
                  <p
                    className={cn(
                      "mt-2 font-display text-[26px] leading-none tabular",
                      key === "promo.unassigned" && value > 0 ? "text-danger" : "text-ink"
                    )}
                  >
                    {value}
                  </p>
                </Card>
              ))}
            </div>

            <Card padding={false}>
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("promo.student")}</Th>
                    <Th>{t("promo.currentClass")}</Th>
                    <Th>{t("promo.nextClass")}</Th>
                    <Th>{t("promo.outcome")}</Th>
                    <Th>{t("promo.basis")}</Th>
                    <Th />
                  </Tr>
                </THead>
                <TBody>
                  {decisions.map((d) => (
                    <Tr key={d._id}>
                      <Td className="font-medium text-ink">
                        {d.studentName ?? d.enrollmentNo ?? d.studentId}
                      </Td>
                      <Td className="text-ink-muted">{d.fromClassName ?? "—"}</Td>
                      <Td className="text-ink-muted">{d.toClassName ?? "—"}</Td>
                      <Td>
                        <Badge variant={OUTCOME_VARIANT[d.outcome]}>
                          {t(`promo.${d.outcome}`)}
                        </Badge>
                      </Td>
                      <Td className="text-xs text-ink-muted">
                        {t(`promo.basis_${d.basis}`)}
                        {d.average !== null && (
                          <span className="ml-1 tabular">({d.average})</span>
                        )}
                      </Td>
                      <Td numeric>
                        {run.status === "draft" && (
                          <button
                            type="button"
                            onClick={() => openEditor(d)}
                            className="rounded-control px-2 py-1 text-xs font-medium text-primary-600 transition-colors hover:bg-canvas"
                          >
                            {t("promo.change")}
                          </button>
                        )}
                        {d.overridden && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">
                            {t("promo.overridden")}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </Card>
          </>
        )}

        {/* Change one decision */}
        <Modal
          open={Boolean(editing)}
          onClose={() => setEditing(null)}
          title={t("promo.changeTitle")}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm font-medium text-ink">
              {editing?.studentName ?? editing?.studentId}
            </p>

            <FormField label={t("promo.outcome")} required>
              <SelectField
                value={edit.outcome}
                onChange={(e) =>
                  setEdit((s) => ({ ...s, outcome: e.target.value as Outcome }))
                }
                options={(["promoted", "repeated", "graduated"] as const).map((o) => ({
                  value: o, label: t(`promo.${o}`),
                }))}
              />
            </FormField>

            {edit.outcome !== "graduated" && (
              <FormField label={t("promo.nextClass")} required>
                <SelectField
                  value={edit.toClassId}
                  placeholder={t("prog.notSet")}
                  onChange={(e) => setEdit((s) => ({ ...s, toClassId: e.target.value }))}
                  options={classes.map((c) => ({ value: c._id, label: c.name }))}
                />
              </FormField>
            )}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                loading={decisionMutation.isPending}
                disabled={edit.outcome !== "graduated" && !edit.toClassId}
                onClick={() => decisionMutation.mutate()}
              >
                {t("common.save")}
              </Button>
            </div>
          </div>
        </Modal>

        {/* Commit */}
        <Modal
          open={commitOpen}
          onClose={() => setCommitOpen(false)}
          title={t("promo.commitTitle")}
          size="sm"
          closeOnBackdrop={false}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">{t("promo.commitBody")}</p>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" onClick={() => setCommitOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button loading={commitMutation.isPending} onClick={() => commitMutation.mutate()}>
                {t("promo.commit")}
              </Button>
            </div>
          </div>
        </Modal>

        {/* Reverse */}
        <Modal
          open={reverseOpen}
          onClose={() => setReverseOpen(false)}
          title={t("promo.reverseTitle")}
          size="sm"
          closeOnBackdrop={false}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">{t("promo.reverseBody")}</p>
            <FormField label={t("promo.reverseReason")} required>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" onClick={() => setReverseOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                loading={reverseMutation.isPending}
                disabled={!reason.trim()}
                onClick={() => reverseMutation.mutate()}
              >
                {t("promo.reverse")}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ── List ───────────────────────────────────────────────────────────────────
  const incomplete = progQ.data?.incomplete ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("promo.title")}
        description={t("promo.blurb")}
        actions={
          <Button icon={<Play className="h-4 w-4" />} onClick={() => setGenOpen(true)}>
            {t("promo.newRun")}
          </Button>
        }
      />

      {incomplete > 0 && (
        <div className="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink-body">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium">{t("prog.incomplete", { count: incomplete })}</p>
            <p className="text-ink-muted">{t("prog.incompleteHint")}</p>
          </div>
        </div>
      )}

      <Card padding={false}>
        {runs.length === 0 ? (
          <EmptyTable title={t("promo.none")} subtitle={t("promo.noneHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("finrep.period")}</Th>
                <Th>{t("common.status")}</Th>
                <Th numeric>{t("promo.promoted")}</Th>
                <Th numeric>{t("promo.repeated")}</Th>
                <Th numeric>{t("promo.graduated")}</Th>
                <Th numeric>{t("promo.unassigned")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {runs.map((r) => (
                <Tr key={r._id} onClick={() => setSelectedId(r._id)}>
                  <Td className="font-medium text-ink">{r.fromYear} → {r.toYear}</Td>
                  <Td>
                    <Badge variant={STATUS_VARIANT[r.status]}>{t(`promo.${r.status}`)}</Badge>
                  </Td>
                  <Td numeric className="text-ink-muted">{r.counts.promoted}</Td>
                  <Td numeric className="text-ink-muted">{r.counts.repeated}</Td>
                  <Td numeric className="text-ink-muted">{r.counts.graduated}</Td>
                  <Td
                    numeric
                    className={r.counts.unassigned > 0 ? "font-semibold text-danger" : "text-ink-muted"}
                  >
                    {r.counts.unassigned}
                  </Td>
                  <Td numeric>
                    <span className="text-xs font-medium text-primary-600">
                      {t("promo.review")}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal open={genOpen} onClose={() => setGenOpen(false)} title={t("promo.newRun")} size="sm">
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); generateMutation.mutate(); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t("promo.fromYear")} required>
              <Input
                value={years.from}
                placeholder="2025/2026"
                onChange={(e) => setYears((y) => ({ ...y, from: e.target.value }))}
              />
            </FormField>
            <FormField label={t("promo.toYear")} required>
              <Input
                value={years.to}
                placeholder="2026/2027"
                onChange={(e) => setYears((y) => ({ ...y, to: e.target.value }))}
              />
            </FormField>
          </div>
          <p className="text-sm text-ink-muted">{t("promo.draftNotice")}</p>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setGenOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={generateMutation.isPending}
              disabled={!years.from.trim() || !years.to.trim()}
            >
              {t("promo.newRun")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
