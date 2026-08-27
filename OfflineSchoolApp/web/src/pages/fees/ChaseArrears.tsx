// web/src/pages/fees/ChaseArrears.tsx
//
// The two things a bursar does with an arrears list: remind the families, and
// charge the ones who are late.
//
// Both are built on the due date entered when the fee structure was set up.
// Both show a preview before anything happens, and that is the whole design
// decision here — one sends messages to families about money and the other adds
// money to their bills, so neither should be a button that acts on the first
// click. Nothing is automatic and there is no scheduler: a school offline for a
// week does not come back to a fortnight of backdated messages going out at once.
//
// ── What the preview must show, and not hide ──────────────────────────────
//
// Families with no phone number or email on file stay on the list, greyed, with
// the reason. Filtering them out would answer "why did only 6 of 9 send?" with
// silence, and "we are owed 40,000 and have no way to contact them" is the most
// useful line on the screen.
//
// Families already reminded inside the cooldown are shown the same way, with the
// option to send anyway — because sometimes a second reminder is exactly the
// intention, and the cooldown exists to stop accidents rather than decisions.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Send, AlarmClock, AlertTriangle, PhoneOff } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { getErrorMessage } from "@/lib/api";
import { usePermission } from "@/lib/permissions";
import {
  fetchReminderCandidates, sendReminders,
  fetchPenaltyCandidates, applyPenalties,
  type ReminderMode,
} from "@/services/fee.service";

interface Props {
  schoolId:     string;
  academicYear: string;
  classId?:     string;
}

export default function ChaseArrears({ schoolId, academicYear, classId }: Props) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const fmt       = useFormat();
  const qc        = useQueryClient();

  const canRemind   = usePermission("fees.remind");
  const canPenalize = usePermission("fees.penalize");

  /** Which preview is open, if any. */
  const [panel, setPanel] = useState<"reminders" | "penalties" | null>(null);
  const [mode,  setMode]  = useState<ReminderMode>("overdue");
  const [force, setForce] = useState(false);

  const remindersQ = useQuery({
    queryKey: ["fees", "reminders", schoolId, academicYear, classId ?? "", mode],
    queryFn:  () => fetchReminderCandidates(schoolId, { academicYear, classId, mode }),
    enabled:  panel === "reminders" && Boolean(schoolId),
  });

  const penaltiesQ = useQuery({
    queryKey: ["fees", "penalties", schoolId, academicYear],
    queryFn:  () => fetchPenaltyCandidates(schoolId, { academicYear }),
    enabled:  panel === "penalties" && Boolean(schoolId),
  });

  const close = () => { setPanel(null); setForce(false); };

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["fees"] });

  const remindM = useMutation({
    mutationFn: () =>
      sendReminders({ schoolId, academicYear, classId, mode, force }),
    onSuccess: async (r) => {
      // All three numbers, always. "9 sent" when three were skipped is the
      // report that gets a bursar shouted at by a parent who was never told.
      toast({
        kind:  r.queued > 0 ? "success" : "info",
        title: t("chase.remindersQueued", { count: r.queued }),
        message: [
          r.skippedRecent > 0
            ? t("chase.skippedRecent", { count: r.skippedRecent })
            : null,
          r.skippedUnreachable > 0
            ? t("chase.skippedUnreachable", { count: r.skippedUnreachable })
            : null,
        ].filter(Boolean).join(" · ") || undefined,
      });
      close();
      await refresh();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("chase.remindFailed"), message: getErrorMessage(err) }),
  });

  const penaliseM = useMutation({
    mutationFn: () => applyPenalties({ schoolId, academicYear }),
    onSuccess: async (r) => {
      toast({
        kind:  r.raised > 0 ? "success" : "info",
        title: t("chase.penaltiesRaised", { count: r.raised }),
        message: r.raised > 0 ? fmt.money(r.total) : undefined,
      });
      close();
      await refresh();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("chase.penaltyFailed"), message: getErrorMessage(err) }),
  });

  // Nothing to offer: the two capabilities are delegable, so a school may have
  // taken either away from the bursar.
  if (!canRemind && !canPenalize) return null;

  const reminderRows = remindersQ.data?.rows ?? [];
  const penaltyRows  = penaltiesQ.data?.rows ?? [];

  /** How many would actually go out, given the cooldown and missing contacts. */
  const willSend = reminderRows.filter(
    (r) => r.reachable && (force || !r.recentlyReminded)
  ).length;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{t("chase.title")}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t("chase.blurb")}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {canRemind && (
              <Button
                variant="secondary"
                icon={<Send className="h-4 w-4" />}
                onClick={() => setPanel("reminders")}
              >
                {t("chase.remind")}
              </Button>
            )}
            {canPenalize && (
              <Button
                variant="secondary"
                icon={<AlarmClock className="h-4 w-4" />}
                onClick={() => setPanel("penalties")}
              >
                {t("chase.penalise")}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ── Reminders ────────────────────────────────────────────────────── */}
      <Modal
        open={panel === "reminders"}
        onClose={close}
        title={t("chase.remindTitle")}
      >
        <div className="flex flex-wrap items-center gap-2">
          {(["overdue", "dueSoon", "all"] as ReminderMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                mode === m
                  ? "border-primary-300 bg-primary-50 text-primary-800"
                  : "border-line bg-surface text-ink-muted hover:text-ink"
              )}
            >
              {t(`chase.mode.${m}`)}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-ink-faint">{t("chase.modeHint")}</p>

        <div className="mt-4 max-h-72 overflow-y-auto">
          {remindersQ.isLoading ? (
            <p className="py-6 text-center text-sm text-ink-muted">{t("common.loading")}</p>
          ) : reminderRows.length === 0 ? (
            <EmptyTable title={t("chase.nobodyToRemind")} />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>{t("chase.student")}</Th>
                  <Th>{t("chase.due")}</Th>
                  <Th numeric>{t("fees.amount")}</Th>
                </Tr>
              </THead>
              <TBody>
                {reminderRows.map((r) => {
                  const skipped = !r.reachable || (!force && r.recentlyReminded);
                  return (
                    <Tr key={r.studentId}>
                      <Td className={skipped ? "text-ink-faint" : undefined}>
                        <div className="font-medium">{r.name}</div>
                        {!r.reachable && (
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                            <PhoneOff className="h-3 w-3" aria-hidden="true" />
                            {t("chase.noContact")}
                          </div>
                        )}
                        {r.reachable && r.recentlyReminded && (
                          <div className="mt-0.5 text-xs text-ink-faint">
                            {t("chase.alreadyReminded", {
                              days: remindersQ.data?.cooldownDays ?? 0,
                            })}
                          </div>
                        )}
                      </Td>
                      <Td className={skipped ? "text-ink-faint" : undefined}>
                        <div className="text-sm">{fmt.dateShort(r.earliestDue)}</div>
                        {r.isOverdue && (
                          <div className="text-xs text-danger">
                            {t("chase.daysLate", { count: r.daysOverdue })}
                          </div>
                        )}
                      </Td>
                      <Td numeric className={skipped ? "text-ink-faint" : "font-medium"}>
                        {fmt.money(r.balance)}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          )}
        </div>

        {reminderRows.some((r) => r.recentlyReminded) && (
          <div className="mt-3">
            <Checkbox
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              label={t("chase.forceLabel")}
              hint={t("chase.forceHint")}
            />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={close}>{t("common.cancel")}</Button>
          <Button
            icon={<Send className="h-4 w-4" />}
            disabled={willSend === 0 || remindM.isPending}
            onClick={() => remindM.mutate()}
          >
            {remindM.isPending
              ? t("common.saving")
              : t("chase.sendN", { count: willSend })}
          </Button>
        </div>
      </Modal>

      {/* ── Late fees ────────────────────────────────────────────────────── */}
      <Modal
        open={panel === "penalties"}
        onClose={close}
        title={t("chase.penaliseTitle")}
      >
        <div className="flex items-start gap-2 rounded-card border border-warning-line bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("chase.penaliseWarning")}</span>
        </div>

        <div className="mt-4 max-h-72 overflow-y-auto">
          {penaltiesQ.isLoading ? (
            <p className="py-6 text-center text-sm text-ink-muted">{t("common.loading")}</p>
          ) : penaltyRows.length === 0 ? (
            <EmptyTable
              title={t("chase.nobodyToPenalise")}
              subtitle={t("chase.nobodyToPenaliseHint")}
            />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>{t("chase.student")}</Th>
                  <Th>{t("chase.rule")}</Th>
                  <Th numeric>{t("chase.lateFee")}</Th>
                </Tr>
              </THead>
              <TBody>
                {penaltyRows.map((r) => (
                  <Tr key={`${r.studentId}-${r.structureId}`}>
                    <Td>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-ink-faint">
                        {t("chase.owesSince", {
                          amount: fmt.money(r.outstanding),
                          days:   r.daysOverdue,
                        })}
                      </div>
                    </Td>
                    <Td className="text-sm text-ink-muted">
                      {r.mode === "percent"
                        ? t("chase.rulePercent", { rate: r.rate })
                        : t("chase.ruleFixed", { amount: fmt.money(r.rate) })}
                    </Td>
                    <Td numeric className="font-medium text-warning">
                      {fmt.money(r.amount)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-muted">
            {penaltyRows.length > 0 &&
              t("chase.penaltyTotal", { amount: fmt.money(penaltiesQ.data?.total ?? 0) })}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={close}>{t("common.cancel")}</Button>
            <Button
              icon={<AlarmClock className="h-4 w-4" />}
              disabled={penaltyRows.length === 0 || penaliseM.isPending}
              onClick={() => penaliseM.mutate()}
            >
              {penaliseM.isPending
                ? t("common.saving")
                : t("chase.raiseN", { count: penaltyRows.length })}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
