// web/src/pages/fees/PaymentPlanPanel.tsx
//
// The instalment arrangement for one family, on their ledger page.
//
// ── What a plan is, and is not ────────────────────────────────────────────
//
// It changes WHEN the fees are due, never how much is owed. The ledger above
// this panel is untouched by it — a school that wants to reduce a bill uses a
// waiver, which is a different act with an approval behind it. What a plan
// changes is the date reminders and late fees measure this family against.
//
// ── Why the schedule must add up exactly ──────────────────────────────────
//
// The server refuses a total that is not the outstanding balance, and the form
// says so before it is submitted. A plan for less would quietly forgive the
// difference; a plan for more would have the family chased for money the ledger
// says they do not owe. Neither is a rescheduling.
//
// ── Why "behind" comes from the server ────────────────────────────────────
//
// It is cumulative — by the third date a family should have paid the first
// three instalments in total, so paying double early and nothing next is on
// track. That arithmetic lives in one place on the server, because this panel
// and the arrears list must never disagree about whether a family is keeping to
// its arrangement.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CalendarClock, Plus, Trash2, XCircle, CheckCircle2, AlertTriangle } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { FormField, Input, Textarea } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { getErrorMessage } from "@/lib/axios";
import { usePermission } from "@/lib/permissions";
import { createPlan, cancelPlan } from "@/services/fee.service";
import type { PaymentPlan, PlanStatus } from "@/types/fees.types";

interface Props {
  schoolId:     string;
  studentId:    string;
  academicYear: string;
  /** What is outstanding right now. The schedule has to match it exactly. */
  balance:      number;
  /** What the family has paid, from the ledger. Ticks off the schedule. */
  paid:         number;
  plan:         PaymentPlan | null;
  status:       PlanStatus | null;
}

/** One row in the form being built. */
interface Row { amount: string; dueDate: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);

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
  schoolId, studentId, academicYear, balance, paid, plan, status,
}: Props) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const fmt       = useFormat();
  const qc        = useQueryClient();

  const canPlan = usePermission("fees.plan");

  const [open,   setOpen]   = useState(false);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState("");
  const [rows,   setRows]   = useState<Row[]>(() => suggest(3, balance));

  const planned = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    [rows]
  );

  const matches = planned === balance;
  const dated   = rows.every((r) => r.dueDate);

  const refresh = () => qc.invalidateQueries({ queryKey: ["fees"] });

  const createM = useMutation({
    mutationFn: () =>
      createPlan({
        schoolId, studentId, academicYear,
        reason: reason.trim(),
        instalments: rows.map((r) => ({
          amount:  Number(r.amount),
          dueDate: r.dueDate,
        })),
      }),
    onSuccess: async () => {
      toast({ kind: "success", title: t("plan.agreed") });
      setOpen(false);
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

  // ── No plan: offer one, if there is anything to reschedule ───────────────
  if (!plan) {
    if (balance <= 0) return null;

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
              onClick={() => { setRows(suggest(3, balance)); setReason(""); setOpen(true); }}
            >
              {t("plan.agree")}
            </Button>
          </div>
        </Card>

        <Modal open={open} onClose={() => setOpen(false)} title={t("plan.agreeTitle")}>
          <p className="text-sm text-ink-muted">
            {t("plan.agreeBlurb", { amount: fmt.money(balance) })}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">{t("plan.split")}</span>
            {[2, 3, 4, 6].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRows(suggest(n, balance))}
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
                      value={r.amount}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x))
                        )
                      }
                    />
                  </FormField>
                </div>

                <div className="col-span-5">
                  <FormField label={i === 0 ? t("plan.due") : ""}>
                    <Input
                      type="date"
                      value={r.dueDate}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x))
                        )
                      }
                    />
                  </FormField>
                </div>

                <div className="col-span-1">
                  {rows.length > 2 && (
                    <button
                      type="button"
                      title={t("common.delete")}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      className="mb-1 rounded-control p-2 text-ink-faint transition-colors hover:bg-canvas hover:text-danger"
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
            onClick={() =>
              setRows((rs) => [...rs, { amount: "0", dueDate: "" }])
            }
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
                ? "border-success-line bg-success-soft text-success"
                : "border-warning-line bg-warning-soft text-warning"
            )}
          >
            <span className="flex items-center gap-1.5">
              {matches
                ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                : <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
              {matches
                ? t("plan.totalMatches")
                : t("plan.totalMismatch", {
                    planned:     fmt.money(planned),
                    outstanding: fmt.money(balance),
                  })}
            </span>
            <span className="font-medium tabular">{fmt.money(planned)}</span>
          </div>

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

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!matches || !dated || !reason.trim() || createM.isPending}
              onClick={() => createM.mutate()}
            >
              {createM.isPending ? t("common.saving") : t("plan.agree")}
            </Button>
          </div>
        </Modal>
      </>
    );
  }

  // ── On a plan: where they stand ──────────────────────────────────────────
  const schedule = [...plan.instalments].sort((a, b) => a.seq - b.seq);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">{t("plan.title")}</h2>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  status?.isBehind
                    ? "bg-danger-soft text-danger"
                    : "bg-success-soft text-success"
                )}
              >
                {status?.isBehind
                  ? t("plan.behind", { amount: fmt.money(status.behindBy) })
                  : t("plan.onTrack")}
              </span>
            </div>

            <p className="mt-1 text-sm text-ink-muted">
              {t("plan.summary", {
                count: schedule.length,
                total: fmt.money(plan.total ?? 0),
              })}
            </p>

            {plan.reason && (
              <p className="mt-0.5 text-xs italic text-ink-faint">{plan.reason}</p>
            )}

            {/* Said plainly, because it is the thing a bursar needs to know
                when deciding whether to chase this family. */}
            <p className="mt-2 text-xs text-ink-faint">
              {status?.isBehind
                ? t("plan.behindHint")
                : t("plan.onTrackHint")}
            </p>
          </div>

          {canPlan && (
            <Button
              variant="secondary"
              icon={<XCircle className="h-4 w-4" />}
              onClick={() => { setReason(""); setEnding(true); }}
            >
              {t("plan.cancel")}
            </Button>
          )}
        </div>

        <ul className="mt-4 divide-y divide-line">
          {schedule.map((inst) => {
            // Cumulative, like everything else about a plan: an instalment is
            // covered once total payments reach the running total up to and
            // including it. So paying the whole plan up front ticks off every
            // row, and paying half ticks off the first half — which is what a
            // parent looking at their own schedule would expect.
            const upTo = schedule
              .filter((x) => x.seq <= inst.seq)
              .reduce((s, x) => s + x.amount, 0);
            const covered = paid >= upTo;
            const overdue = Boolean(
              status?.missedSince && new Date(inst.dueDate) <= new Date(status.missedSince)
            );

            return (
              <li key={inst.seq} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-xs text-ink-faint">{inst.seq}</span>
                  <span className={cn(overdue && "text-danger")}>
                    {fmt.dateShort(inst.dueDate)}
                  </span>
                  {covered && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  )}
                </span>
                <span className="text-sm font-medium tabular text-ink">
                  {fmt.money(inst.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

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
