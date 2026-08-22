// web/src/pages/finance/payroll.tsx
//
// Generate a month → review the drafts → confirm.
//
// The three-step shape is the whole point: generating writes nothing anybody
// gets paid from, and payslip numbers are only minted on confirmation, so the
// sequence contains no holes for runs that were discarded. A confirmed run is
// never edited — it is reversed, which appends mirror payslips and leaves the
// originals exactly as issued.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play, ChevronLeft, Info } from "lucide-react";

import { useUser }          from "@/store/auth.store";
import { PageHeader }       from "@/components/ui/PageHeader";
import { Card }             from "@/components/ui/Card";
import { Button }           from "@/components/ui/Button";
import { Badge }            from "@/components/ui/Badge";
import { Modal }            from "@/components/ui/Modal";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { useToast }         from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }        from "@/i18n/format";
import { getErrorMessage }  from "@/lib/api";
import {
  fetchRuns, fetchRun, generateRun, confirmRun, reverseRun,
} from "@/services/finance.service";
import type { RunStatus, SpendMethod } from "@/types/finance.types";

const METHODS: SpendMethod[] = ["cash", "mobile_money", "bank", "cheque", "other"];

const STATUS_VARIANT: Record<RunStatus, "warning" | "success" | "default"> = {
  draft:     "warning",
  confirmed: "success",
  reversed:  "default",
};

/** Current month as YYYY-MM, which is what the API expects. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function PayrollPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [genOpen, setGenOpen]       = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [month, setMonth]   = useState(thisMonth());
  const [method, setMethod] = useState<SpendMethod>("bank");
  const [reason, setReason] = useState("");

  const runsQ = useQuery({
    queryKey: ["finance", "payroll", schoolId],
    queryFn:  () => fetchRuns(schoolId),
    enabled:  !!schoolId,
  });

  const detailQ = useQuery({
    queryKey: ["finance", "payroll", schoolId, selectedId],
    queryFn:  () => fetchRun(selectedId as string, schoolId),
    enabled:  !!schoolId && !!selectedId,
  });

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["finance"] }); };

  const generateMutation = useMutation({
    mutationFn: () => generateRun(schoolId, month),
    onSuccess: (res) => {
      toast({ kind: "success", title: t("payroll.generated") });
      setGenOpen(false);
      invalidate();
      setSelectedId(res.run._id);
    },
    onError: (err) =>
      toast({ kind: "error", title: t("payroll.generate"), message: getErrorMessage(err) }),
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmRun(selectedId as string, schoolId, method),
    onSuccess: () => {
      toast({ kind: "success", title: t("payroll.confirmedToast") });
      setConfirmOpen(false);
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("payroll.confirmRun"), message: getErrorMessage(err) }),
  });

  const reverseMutation = useMutation({
    mutationFn: () => reverseRun(selectedId as string, schoolId, reason.trim()),
    onSuccess: () => {
      toast({ kind: "success", title: t("payroll.reversedToast") });
      setReverseOpen(false);
      setReason("");
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("payroll.reverseRun"), message: getErrorMessage(err) }),
  });

  if (runsQ.isLoading) return <PageSpinner />;

  const runs = runsQ.data ?? [];

  // ── Detail view ────────────────────────────────────────────────────────────
  if (selectedId) {
    const detail   = detailQ.data;
    const run      = detail?.run;
    const payslips = detail?.payslips ?? [];

    return (
      <div className="space-y-5">
        <PageHeader
          title={run ? fmt.monthLabel(run.periodMonth) : t("payroll.title")}
          description={run ? t(`payroll.${run.status}`) : undefined}
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
                <Button onClick={() => setConfirmOpen(true)}>{t("payroll.confirmRun")}</Button>
              )}
              {run?.status === "confirmed" && (
                <Button variant="danger" onClick={() => setReverseOpen(true)}>
                  {t("payroll.reverseRun")}
                </Button>
              )}
            </>
          }
        />

        {detailQ.isLoading || !run ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <>
            {run.status === "draft" && (
              <div className="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink-body">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <p>{t("payroll.draftNotice")}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([
                ["payroll.staffLabel", run.staffCount, false],
                ["salaries.gross",           run.totalGross, true],
                ["salaries.deductions",      run.totalDeductions, true],
                ["salaries.net",             run.totalNet, true],
              ] as const).map(([key, value, isMoney]) => (
                <Card key={key}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {t(key)}
                  </p>
                  <p className="mt-2 font-display text-[22px] leading-none text-ink tabular">
                    {isMoney ? fmt.money(value) : fmt.number(value)}
                  </p>
                </Card>
              ))}
            </div>

            <Card padding={false}>
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("salaries.staff")}</Th>
                    <Th>{t("payroll.payslipNo")}</Th>
                    <Th numeric>{t("salaries.base")}</Th>
                    <Th numeric>{t("salaries.allowances")}</Th>
                    <Th numeric>{t("salaries.deductions")}</Th>
                    <Th numeric>{t("salaries.net")}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {payslips.map((p) => (
                    <Tr key={p._id}>
                      <Td className="font-medium text-ink">{p.staff?.name ?? p.userId}</Td>
                      <Td className="text-ink-muted">
                        {p.payslipNo ?? (
                          <span className="text-ink-faint">{t("payroll.pendingNumber")}</span>
                        )}
                      </Td>
                      <Td numeric className="text-ink-muted">{fmt.money(p.baseAmount)}</Td>
                      <Td numeric className="text-ink-muted">
                        {fmt.money(p.allowances.reduce((s, a) => s + a.amount, 0))}
                      </Td>
                      <Td numeric className="text-ink-muted">{fmt.money(p.totalDeductions)}</Td>
                      <Td numeric className="font-semibold text-ink">{fmt.money(p.net)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </Card>
          </>
        )}

        <Modal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title={t("payroll.confirmTitle")}
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">{t("payroll.confirmBody")}</p>
            <FormField label={t("fees.method")} required>
              <SelectField
                value={method}
                onChange={(e) => setMethod(e.target.value as SpendMethod)}
                options={METHODS.map((m) => ({ value: m, label: t(`method.${m}`) }))}
              />
            </FormField>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button loading={confirmMutation.isPending} onClick={() => confirmMutation.mutate()}>
                {t("payroll.confirmRun")}
              </Button>
            </div>
          </div>
        </Modal>

        <Modal
          open={reverseOpen}
          onClose={() => setReverseOpen(false)}
          title={t("payroll.reverseTitle")}
          size="sm"
          closeOnBackdrop={false}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">{t("payroll.reverseBody")}</p>
            <FormField label={t("payroll.reverseReason")} required>
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
                {t("payroll.reverseRun")}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <PageHeader
        title={t("payroll.title")}
        description={t("payroll.blurb")}
        actions={
          <Button icon={<Play className="h-4 w-4" />} onClick={() => setGenOpen(true)}>
            {t("payroll.generate")}
          </Button>
        }
      />

      <Card padding={false}>
        {runs.length === 0 ? (
          <EmptyTable title={t("payroll.none")} subtitle={t("payroll.noneHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("payroll.month")}</Th>
                <Th>{t("common.status")}</Th>
                <Th numeric>{t("salaries.staff")}</Th>
                <Th numeric>{t("salaries.gross")}</Th>
                <Th numeric>{t("salaries.net")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {runs.map((r) => (
                <Tr key={r._id} onClick={() => setSelectedId(r._id)}>
                  <Td className="font-medium text-ink">{fmt.monthLabel(r.periodMonth)}</Td>
                  <Td>
                    <Badge variant={STATUS_VARIANT[r.status]}>{t(`payroll.${r.status}`)}</Badge>
                  </Td>
                  <Td numeric className="text-ink-muted">{fmt.number(r.staffCount)}</Td>
                  <Td numeric className="text-ink-muted">{fmt.money(r.totalGross)}</Td>
                  <Td numeric className="font-semibold text-ink">{fmt.money(r.totalNet)}</Td>
                  <Td numeric>
                    <span className="text-xs font-medium text-primary-600">
                      {t("payroll.review")}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal open={genOpen} onClose={() => setGenOpen(false)} title={t("payroll.generate")} size="sm">
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); generateMutation.mutate(); }}
        >
          <FormField label={t("payroll.month")} required>
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </FormField>
          <p className="text-sm text-ink-muted">{t("payroll.draftNotice")}</p>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setGenOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={generateMutation.isPending} disabled={!month}>
              {t("payroll.generate")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
