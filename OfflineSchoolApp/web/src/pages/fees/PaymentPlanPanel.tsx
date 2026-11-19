// web/src/pages/fees/PaymentPlanPanel.tsx
//
// The individual fee agreement for one pupil, on their ledger page.
//
// ── What an agreement is, and is not ──────────────────────────────────────
//
// It changes WHEN the fees are due, never how much is owed. The ledger above
// this panel is untouched by it — a school that wants to reduce a bill uses a
// waiver, which is a different act with an approval behind it. What an
// agreement changes is the schedule this pupil is measured against: reminders,
// late fees, and the gate's compliance check.
//
// ── Why the schedule must add up exactly ──────────────────────────────────
//
// Either to the year's whole bill (the 50,000 + 50,000 + 100,000 that replaces
// the structure's 75,000 + 75,000 + 50,000), or to what is still outstanding.
// The server refuses anything else, and the form says so before it is
// submitted. A schedule for less would quietly forgive the difference; one for
// more would chase money the ledger says is not owed.
//
// ── Approval ──────────────────────────────────────────────────────────────
//
// The bursar proposes; an administrator who is not the proposer approves it
// in the approvals queue. Until then it governs nothing: the general schedule
// still applies, and this panel says so. A change to an approved agreement
// waits the same way while the approved schedule keeps applying.
//
// ── Why "behind" comes from the server ────────────────────────────────────
//
// It is cumulative — by the third date a family should have paid the first
// three instalments in total. That arithmetic lives in one place
// (shared/arrears.js), so this panel, the arrears list and the gate never
// disagree about whether a family is keeping to its agreement.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  CalendarClock, Plus, Trash2, XCircle, CheckCircle2, AlertTriangle, Hourglass, PencilLine, History,
} from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { FormField, Input, Textarea } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { getErrorMessage } from "@/lib/axios";
import { usePermission } from "@/lib/permissions";
import { createPlan, cancelPlan, updatePlan } from "@/services/fee.service";
import type { PaymentPlan, PlanStatus } from "@/types/fees.types";

interface Props {
  schoolId:     string;
  studentId:    string;
  academicYear: string;
  /** What is outstanding right now. */
  balance:      number;
  /** The year's whole bill, net of waivers. */
  billed:       number;
  /** What the family has paid, from the ledger. Ticks off the schedule. */
  paid:         number;
  plan:         PaymentPlan | null;
  status:       PlanStatus | null;
  /** Whether the plan governs today (approved and within its dates). */
  applies?:     boolean;
}

/** One row in the form being built. */
interface Row { amount: string; dueDate: string }

type Covers = "total" | "balance";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "");

/**
 * A starting schedule: n equal instalments, one month apart, first next month.
 *
 * Offered rather than imposed — every row stays editable. The remainder goes on
 * the FIRST instalment, not the last: 60,001 across three becomes 20,001 +
 * 20,000 + 20,000, so a family is never asked for an odd franc at the end of an
 * arrangement they have nearly finished.
 */
const suggest = (count: number, total: number): Row[] => {
  const base = Math.floor(total / count);
  const rest = total - base * count;

  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + i + 1, 15);
    return {
      amount:  String(i === 0 ? base + rest : base),
      dueDate: iso(d),
    };
  });
};

export default function PaymentPlanPanel({
  schoolId, studentId, academicYear, balance, billed, paid, plan, status, applies = true,
}: Props) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const fmt       = useFormat();
  const qc        = useQueryClient();

  const canPlan = usePermission("fees.plan");

  // "create" (a new agreement) or "change" (to the existing one).
  const [mode,   setMode]   = useState<"create" | "change" | null>(null);
  const [ending, setEnding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reason, setReason] = useState("");
  const [covers, setCovers] = useState<Covers>("total");
  const [rows,   setRows]   = useState<Row[]>(() => suggest(3, billed));
  const [from,   setFrom]   = useState("");
  const [until,  setUntil]  = useState("");
  const [notes,  setNotes]  = useState("");

  // Nothing paid yet: the two targets are the same figure, so only one is offered.
  const sameTarget = billed === balance;
  const target  = covers === "total" ? billed : balance;
  const planned = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    [rows]
  );
  const matches = planned === target;
  const dated   = rows.every((r) => r.dueDate);
  const datesOk = !from || !until || until >= from;

  const refresh = () => qc.invalidateQueries({ queryKey: ["fees"] });

  const instalmentsOut = () =>
    rows.map((r) => ({ amount: Number(r.amount), dueDate: r.dueDate }));

  const openCreate = () => {
    setCovers("total");
    setRows(suggest(3, billed));
    setReason(""); setFrom(""); setUntil(""); setNotes("");
    setMode("create");
  };

  const openChange = () => {
    if (!plan) return;
    setCovers(plan.basis === "balance" ? "balance" : "total");
    setRows([...plan.instalments].sort((a, b) => a.seq - b.seq)
      .map((i) => ({ amount: String(i.amount), dueDate: day(i.dueDate) })));
    setReason("");
    setFrom(day(plan.effectiveFrom)); setUntil(day(plan.expiresAt)); setNotes(plan.notes ?? "");
    setMode("change");
  };

  const saveM = useMutation({
    mutationFn: () => {
      const common = {
        schoolId,
        reason: reason.trim(),
        instalments: instalmentsOut(),
        effectiveFrom: from || null,
        expiresAt:     until || null,
        notes:         notes.trim() || null,
      };
      return mode === "change" && plan
        ? updatePlan(plan._id, common)
        : createPlan({ ...common, studentId, academicYear });
    },
    onSuccess: async () => {
      toast({ kind: "success", title: t(mode === "change" ? "plan.changeSent" : "plan.sentForApproval") });
      setMode(null);
      setReason("");
      await refresh();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("plan.agreeFailed"), message: getErrorMessage(err) }),
  });

  const cancelM = useMutation({
    mutationFn: () => cancelPlan(plan!._id, schoolId, reason.trim()),
    onSuccess: async () => {
      toast({ kind: "success", title: t("plan.cancelled") });
      setEnding(false);
      setReason("");
      await refresh();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("plan.cancelFailed"), message: getErrorMessage(err) }),
  });

  if (!canPlan && !plan) return null;
  if (!plan && balance <= 0) return null;

  const form = (
    <Modal
      open={mode !== null}
      onClose={() => setMode(null)}
      title={t(mode === "change" ? "plan.changeTitle" : "plan.agreeTitle")}
    >
      <p className="text-sm text-ink-muted">
        {t("plan.agreementBlurb")}
      </p>

      {/* What the schedule covers. Offered only when the two differ. */}
      {!sameTarget && (
        <fieldset className="mt-4">
          <legend className="text-xs font-medium text-ink-muted">{t("plan.covers")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["total", "balance"] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={covers === c}
                onClick={() => { setCovers(c); setRows(suggest(rows.length, c === "total" ? billed : balance)); }}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  covers === c
                    ? "border-primary-300 bg-primary-50 text-primary-800"
                    : "border-line bg-surface text-ink-muted hover:text-ink"
                )}
              >
                {c === "total"
                  ? t("plan.coversTotal", { amount: fmt.money(billed) })
                  : t("plan.coversBalance", { amount: fmt.money(balance) })}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-faint">{t("plan.split")}</span>
        {[2, 3, 4, 6].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRows(suggest(n, target))}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              rows.length === n
                ? "border-primary-300 bg-primary-50 text-primary-800"
                : "border-line bg-surface text-ink-muted hover:text-ink"
            )}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-12 items-end gap-2">
            <span className="col-span-1 pb-2 text-xs text-ink-faint">{i + 1}</span>

            <div className="col-span-5">
              <FormField label={i === 0 ? t("fees.amount") : ""}>
                <Input
                  inputMode="numeric"
                  aria-label={t("plan.instalmentAmount", { n: i + 1 })}
                  value={r.amount}
                  onChange={(e) =>
                    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                />
              </FormField>
            </div>

            <div className="col-span-5">
              <FormField label={i === 0 ? t("plan.due") : ""}>
                <Input
                  type="date"
                  aria-label={t("plan.instalmentDate", { n: i + 1 })}
                  value={r.dueDate}
                  onChange={(e) =>
                    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))
                  }
                />
              </FormField>
            </div>

            <div className="col-span-1">
              {rows.length > 2 && (
                <button
                  type="button"
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  className="mb-1 rounded-control p-2 text-ink-faint transition-colors hover:bg-canvas hover:text-danger-text"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { amount: "0", dueDate: "" }])}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        {t("plan.addInstalment")}
      </button>

      {/* The total, and whether it is allowed. Said before the click, not
          explained after a 400. */}
      <div
        className={cn(
          "mt-4 flex items-center justify-between rounded-card border px-3 py-2 text-sm",
          matches
            ? "border-success-line bg-success-soft text-success-text"
            : "border-warning-line bg-warning-soft text-warning-text"
        )}
      >
        <span className="flex items-center gap-1.5">
          {matches
            ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            : <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
          {matches
            ? t("plan.totalMatchesTarget")
            : t("plan.totalMismatchTarget", { planned: fmt.money(planned), target: fmt.money(target) })}
        </span>
        <span className="font-medium tabular">{fmt.money(planned)}</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label={t("plan.effectiveFrom")} hint={t("plan.effectiveFromHint")}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label={t("plan.expiresAt")} hint={t("plan.expiresAtHint")}>
          <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </FormField>
      </div>
      {!datesOk && (
        <p className="mt-1 text-xs text-danger-text">{t("plan.datesBackwards")}</p>
      )}

      <div className="mt-4">
        <FormField label={t("plan.reason")} hint={t("plan.reasonHint")} required>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("plan.reasonPlaceholder")}
          />
        </FormField>
      </div>

      <div className="mt-4">
        <FormField label={t("plan.notes")} hint={t("plan.notesHint")}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-faint">
        <Hourglass className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
        {t("plan.approvalNote")}
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setMode(null)}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!matches || !dated || !datesOk || !reason.trim() || saveM.isPending}
          onClick={() => saveM.mutate()}
        >
          {saveM.isPending ? t("common.saving") : t(mode === "change" ? "plan.proposeChange" : "plan.agree")}
        </Button>
      </div>
    </Modal>
  );

  // ── No plan: offer one, if there is anything to reschedule ───────────────
  if (!plan) {
    return (
      <>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">{t("plan.title")}</h2>
              <p className="mt-1 text-sm text-ink-muted">{t("plan.none")}</p>
            </div>
            <Button
              variant="secondary"
              icon={<CalendarClock className="h-4 w-4" />}
              onClick={openCreate}
            >
              {t("plan.agree")}
            </Button>
          </div>
        </Card>
        {form}
      </>
    );
  }

  // ── On an agreement: its approval, where they stand, its history ─────────
  const schedule = [...plan.instalments].sort((a, b) => a.seq - b.seq);
  const pending  = plan.approvalStatus === "pending";
  // A "balance" agreement's schedule starts after what was paid before it.
  const towardPlan = Math.max(0, paid - (plan.baselinePaid ?? 0));
  const total = plan.agreedTotal ?? plan.total ?? schedule.reduce((s, i) => s + i.amount, 0);

  const badge = pending
    ? { cls: "bg-warning-soft text-warning-text", text: t("plan.pendingApproval") }
    : !applies
      ? { cls: "bg-info-soft text-info-text", text: t("plan.notInForce") }
      : status?.isBehind
        ? { cls: "bg-danger-soft text-danger-text", text: t("plan.behind", { amount: fmt.money(status.behindBy) }) }
        : { cls: "bg-success-soft text-success-text", text: t("plan.onTrack") };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">{t("plan.title")}</h2>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", badge.cls)}>
                {badge.text}
              </span>
              {plan.pendingChange && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-text">
                  {t("plan.changePending")}
                </span>
              )}
            </div>

            <p className="mt-1 text-sm text-ink-muted">
              {t("plan.summary", { count: schedule.length, total: fmt.money(total) })}
              {plan.basis === "balance" && ` · ${t("plan.basisBalanceShort")}`}
            </p>

            {(plan.effectiveFrom || plan.expiresAt) && (
              <p className="mt-0.5 text-xs text-ink-faint">
                {t("plan.inForce", {
                  from:  plan.effectiveFrom ? fmt.dateShort(plan.effectiveFrom) : "—",
                  until: plan.expiresAt ? fmt.dateShort(plan.expiresAt) : t("plan.noExpiry"),
                })}
              </p>
            )}

            {plan.reason && (
              <p className="mt-0.5 text-xs italic text-ink-faint">{plan.reason}</p>
            )}
            {plan.notes && (
              <p className="mt-0.5 whitespace-pre-line text-xs text-ink-muted">{plan.notes}</p>
            )}

            {/* Said plainly, because it is the thing a bursar needs to know
                when deciding whether to chase this family. */}
            <p className="mt-2 text-xs text-ink-faint">
              {pending
                ? t("plan.pendingApprovalHint")
                : !applies
                  ? t("plan.notInForceHint")
                  : status?.isBehind ? t("plan.behindHint") : t("plan.onTrackHint")}
            </p>
          </div>

          {canPlan && (
            <div className="flex flex-wrap gap-2">
              {!plan.pendingChange && (
                <Button variant="secondary" icon={<PencilLine className="h-4 w-4" />} onClick={openChange}>
                  {t("plan.proposeChange")}
                </Button>
              )}
              <Button
                variant="secondary"
                icon={<XCircle className="h-4 w-4" />}
                onClick={() => { setReason(""); setEnding(true); }}
              >
                {t("plan.cancel")}
              </Button>
            </div>
          )}
        </div>

        <ul className="mt-4 divide-y divide-line">
          {schedule.map((inst) => {
            // Cumulative, like everything else about a plan: an instalment is
            // covered once payments toward it reach the running total up to and
            // including it.
            const upTo = schedule
              .filter((x) => x.seq <= inst.seq)
              .reduce((s, x) => s + x.amount, 0);
            const covered = towardPlan >= upTo;
            const overdue = Boolean(
              applies && status?.missedSince && new Date(inst.dueDate) <= new Date(status.missedSince)
            );

            return (
              <li key={inst.seq} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-xs text-ink-faint">{inst.seq}</span>
                  <span className={cn(overdue && "text-danger-text")}>
                    {fmt.dateShort(inst.dueDate)}
                  </span>
                  {covered && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success-text" aria-label={t("plan.covered")} />
                  )}
                </span>
                <span className="text-sm font-medium tabular text-ink">
                  {fmt.money(inst.amount)}
                </span>
              </li>
            );
          })}
        </ul>

        {plan.pendingChange && (
          <div className="mt-3 rounded-card border border-warning-line bg-warning-soft p-3 text-xs text-warning-text">
            <p className="font-medium">{t("plan.changePendingHint")}</p>
            <ul className="mt-1 space-y-0.5">
              {[...plan.pendingChange.instalments].sort((a, b) => a.seq - b.seq).map((i) => (
                <li key={i.seq} className="flex justify-between gap-3 tabular">
                  <span>{i.seq}. {fmt.dateShort(i.dueDate)}</span>
                  <span>{fmt.money(i.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(plan.history?.length ?? 0) > 0 && (
          <div className="mt-4">
            <button
              type="button"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
            >
              <History className="h-3.5 w-3.5" aria-hidden="true" />
              {t("plan.history", { count: plan.history!.length })}
            </button>
            {showHistory && (
              <ol className="mt-2 space-y-2 border-l border-line pl-3">
                {[...plan.history!].reverse().map((h, i) => (
                  <li key={i} className="text-xs">
                    <p className="text-ink">
                      <span className="font-medium">{t(`plan.action.${h.action}`)}</span>
                      <span className="text-ink-faint"> · {fmt.dateShort(h.at)}</span>
                    </p>
                    {h.note && <p className="italic text-ink-muted">{h.note}</p>}
                    {h.before?.instalments && h.after?.instalments && (
                      <p className="tabular text-ink-faint">
                        {h.before.instalments.map((x) => fmt.money(x.amount)).join(" + ")}
                        {" → "}
                        {h.after.instalments.map((x) => fmt.money(x.amount)).join(" + ")}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </Card>

      {form}

      <Modal open={ending} onClose={() => setEnding(false)} title={t("plan.cancelTitle")}>
        <p className="text-sm text-ink-muted">{t("plan.cancelBlurb")}</p>

        <div className="mt-4">
          <FormField label={t("plan.reason")} required>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("plan.cancelPlaceholder")}
            />
          </FormField>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setEnding(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!reason.trim() || cancelM.isPending}
            onClick={() => cancelM.mutate()}
          >
            {cancelM.isPending ? t("common.saving") : t("plan.cancel")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
