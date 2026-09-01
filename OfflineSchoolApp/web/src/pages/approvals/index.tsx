// web/src/pages/approvals/index.tsx
//
// What is waiting for a second signature.
//
// One screen, two readings, and the server decides which one you get:
//
//   A head teacher sees the school's queue with Approve and Reject on each row.
//   A bursar sees the requests they raised, with a status and the option to
//   withdraw one — and no buttons, because approving your own request is
//   refused by the API and offering the control would be a lie.
//
// ── Why the history is on the same screen ─────────────────────────────────
//
// The status filter includes "all", and that is what makes this the audit trail
// rather than an inbox. The question asked months later is "who signed off on
// that refund", and it has to be answerable somewhere a head teacher can reach
// without a database client. Decided rows are immutable server-side, so what is
// shown here cannot have been tidied up afterwards.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ShieldCheck, Check, X, Undo2, AlertTriangle, Clock,
  Receipt, Banknote, HandCoins, CalendarClock,
} from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Modal }       from "@/components/ui/Modal";
import { PageSpinner } from "@/components/ui/Spinner";
import { FormField, Textarea } from "@/components/ui/FormField";
import { useToast }    from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";
import { getErrorMessage } from "@/lib/axios";
import {
  fetchApprovals, approveRequest, rejectRequest, cancelRequest,
  type ApprovalKind, type ApprovalRequest, type ApprovalStatus,
} from "@/services/approval.service";

// ─────────────────────────────────────────────────────────────────────────────

const KIND_ICON: Record<ApprovalKind, typeof Receipt> = {
  expense: Receipt,
  refund:  HandCoins,
  waiver:  Banknote,
  payroll: CalendarClock,
};

const STATUS_STYLE: Record<ApprovalStatus, string> = {
  pending:   "bg-warning-soft text-warning",
  approved:  "bg-success-soft text-success",
  rejected:  "bg-danger-soft text-danger",
  cancelled: "bg-surface-muted text-ink-faint",
};

const FILTERS: Array<ApprovalStatus | "all"> = ["pending", "approved", "rejected", "all"];

export default function ApprovalsPage() {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();
  const fmt       = useFormat();
  const user      = useUser();
  const schoolId  = user?.schoolId ?? "";

  const [status, setStatus] = useState<ApprovalStatus | "all">("pending");

  /** The row being rejected, and the reason being typed for it. */
  const [rejecting, setRejecting] = useState<ApprovalRequest | null>(null);
  const [note,      setNote]      = useState("");

  const query = useQuery({
    queryKey: ["approvals", schoolId, status],
    queryFn:  () => fetchApprovals(schoolId, { status }),
    enabled:  Boolean(schoolId),
  });

  const rows      = useMemo(() => query.data?.rows ?? [], [query.data]);
  const canDecide = Boolean(query.data?.canDecide);

  const invalidate = async () => {
    // The dashboard tile and the finance screens read the same facts.
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["approvals"] }),
      qc.invalidateQueries({ queryKey: ["finance"] }),
      qc.invalidateQueries({ queryKey: ["fees"] }),
    ]);
  };

  const decision = useMutation({
    mutationFn: async (
      p: { id: string; approve: boolean; note?: string }
    ) =>
      p.approve
        ? approveRequest(p.id, schoolId, p.note)
        : rejectRequest(p.id, schoolId, p.note ?? ""),
    onSuccess: async (_data, p) => {
      toast({
        kind:  "success",
        title: p.approve ? t("approvals.approved") : t("approvals.rejected"),
      });
      setRejecting(null);
      setNote("");
      await invalidate();
    },
    onError: (err) => {
      /*
        A decision can be recorded and still fail to take effect — an approved
        waiver whose charge shrank in the meantime. The API says so explicitly,
        and both facts are told, because hiding either would leave somebody
        believing the wrong one.
      */
      const recorded = (err as { response?: { data?: { decisionRecorded?: boolean } } })
        ?.response?.data?.decisionRecorded;
      toast({
        kind:    "error",
        title:   recorded ? t("approvals.recordedNotApplied") : t("approvals.decisionFailed"),
        message: getErrorMessage(err),
      });
      void invalidate();
    },
  });

  const withdrawal = useMutation({
    mutationFn: (id: string) => cancelRequest(id, schoolId),
    onSuccess:  async () => {
      toast({ kind: "success", title: t("approvals.withdrawn") });
      await invalidate();
    },
    onError: (err) => {
      toast({
        kind: "error", title: t("approvals.withdrawFailed"),
        message: getErrorMessage(err),
      });
    },
  });

  if (!schoolId) return null;
  if (query.isLoading) return <PageSpinner />;

  const busy = decision.isPending || withdrawal.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("approvals.title")}
        description={canDecide ? t("approvals.blurbDecider") : t("approvals.blurbRequester")}
        meta={
          status === "pending" && rows.length > 0
            ? <span>{t("approvals.waitingCount", { total: rows.length })}</span>
            : undefined
        }
      />

      {/* ── Filter ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setStatus(f)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium transition",
              status === f
                ? "border-primary-300 bg-primary-50 text-primary-800"
                : "border-line bg-surface text-ink-muted hover:text-ink"
            )}
          >
            {t(`approvals.filter.${f}`)}
          </button>
        ))}
      </div>

      <Card padding={false}>
        {rows.length === 0 ? (
          <EmptyTable
            icon={<ShieldCheck className="h-6 w-6 text-ink-faint" aria-hidden="true" />}
            title={
              status === "pending"
                ? t("approvals.noneWaiting")
                : t("approvals.noneMatching")
            }
            subtitle={
              status === "pending" && canDecide
                ? t("approvals.noneWaitingHint")
                : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("approvals.what")}</Th>
                <Th numeric>{t("approvals.amount")}</Th>
                <Th>{t("approvals.raised")}</Th>
                <Th>{t("approvals.state")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {rows.map((r) => {
                const Icon = KIND_ICON[r.kind] ?? Receipt;
                const mine = String(r.requestedBy ?? "") === String(user?._id ?? "");

                return (
                  <Tr key={r._id}>
                    <Td>
                      <div className="flex items-start gap-2.5">
                        <Icon
                          className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-ink">
                            {r.summary || t(`approvals.kind.${r.kind}`)}
                          </div>
                          <div className="text-xs text-ink-faint">
                            {t(`approvals.kind.${r.kind}`)}
                            {r.reason ? ` — ${r.reason}` : ""}
                          </div>

                          {/* The rule that caught it, as it stood then. */}
                          {r.thresholdAtRequest !== null && (
                            <div className="mt-0.5 text-xs text-ink-faint">
                              {t("approvals.threshold", {
                                amount: fmt.money(r.thresholdAtRequest),
                              })}
                            </div>
                          )}

                          {r.decisionNote && (
                            <div className="mt-1 text-xs italic text-ink-muted">
                              {t("approvals.note", { note: r.decisionNote })}
                            </div>
                          )}

                          {/* Approved but never carried out. Loud on purpose:
                              somebody believes this happened and it did not. */}
                          {r.applyError && (
                            <div className="mt-1 flex items-start gap-1.5 text-xs text-danger">
                              <AlertTriangle
                                className="mt-0.5 h-3 w-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span>
                                {t("approvals.notApplied", { error: r.applyError })}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>

                    <Td numeric className="font-medium">{fmt.money(r.amount)}</Td>

                    <Td>
                      <div className="text-sm text-ink">{fmt.dateShort(r.requestedAt)}</div>
                      {mine && (
                        <div className="text-xs text-ink-faint">{t("approvals.byYou")}</div>
                      )}
                    </Td>

                    <Td>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                          STATUS_STYLE[r.status]
                        )}
                      >
                        {r.status === "pending" && (
                          <Clock className="h-3 w-3" aria-hidden="true" />
                        )}
                        {t(`approvals.status.${r.status}`)}
                      </span>
                    </Td>

                    <Td>
                      {r.status !== "pending" ? null : canDecide && !mine ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            disabled={busy}
                            icon={<Check className="h-3.5 w-3.5" />}
                            onClick={() =>
                              decision.mutate({ id: r._id, approve: true })
                            }
                          >
                            {t("approvals.approve")}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            icon={<X className="h-3.5 w-3.5" />}
                            onClick={() => { setRejecting(r); setNote(""); }}
                          >
                            {t("approvals.reject")}
                          </Button>
                        </div>
                      ) : mine ? (
                        <div className="flex flex-col items-end gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            icon={<Undo2 className="h-3.5 w-3.5" />}
                            onClick={() => withdrawal.mutate(r._id)}
                          >
                            {t("approvals.withdraw")}
                          </Button>
                          {/*
                            Said rather than left to be discovered by a greyed
                            button: a head teacher who raised a request is
                            looking for the Approve control and needs to know why
                            it is not there.
                          */}
                          {canDecide && (
                            <span className="text-xs text-ink-faint">
                              {t("approvals.cannotDecideOwn")}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-ink-faint">
                          {t("approvals.awaitingOther")}
                        </span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {/* ── Rejecting needs a reason ───────────────────────────────────────── */}
      <Modal
        open={Boolean(rejecting)}
        onClose={() => { setRejecting(null); setNote(""); }}
        title={t("approvals.rejectTitle")}
      >
        <p className="text-sm text-ink-muted">
          {t("approvals.rejectBlurb", {
            what: rejecting?.summary || t(`approvals.kind.${rejecting?.kind ?? "expense"}`),
            amount: fmt.money(rejecting?.amount ?? 0),
          })}
        </p>

        <div className="mt-4">
          <FormField label={t("approvals.reason")}>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={t("approvals.reasonPlaceholder")}
            />
          </FormField>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => { setRejecting(null); setNote(""); }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!note.trim() || decision.isPending}
            onClick={() =>
              rejecting &&
              decision.mutate({ id: rejecting._id, approve: false, note: note.trim() })
            }
          >
            {t("approvals.reject")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
