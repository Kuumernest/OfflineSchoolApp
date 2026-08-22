// web/src/pages/finance/salaries.tsx
//
// What each staff member is owed monthly.
//
// A salary is published, not edited — the same rule as a fee structure. Setting
// a new one closes the old row at effectiveFrom − 1ms instead of overwriting
// it, so a payslip issued in March still reproduces March's figures after a
// June raise. That is why there is no edit button here.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Wallet } from "lucide-react";

import { useUser }          from "@/store/auth.store";
import { PageHeader }       from "@/components/ui/PageHeader";
import { Card }             from "@/components/ui/Card";
import { Button }           from "@/components/ui/Button";
import { Modal }            from "@/components/ui/Modal";
import { PageSpinner }      from "@/components/ui/Spinner";
import { FormField, Input, SelectField } from "@/components/ui/FormField";
import { useToast }         from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }        from "@/i18n/format";
import { getErrorMessage }  from "@/lib/api";
import {
  fetchStaff, fetchSalaryStructures, createSalaryStructure,
} from "@/services/finance.service";
import type { SalaryComponent } from "@/types/finance.types";

const emptyComponent = (): SalaryComponent => ({ code: "", label: "", amount: 0 });

/** Today as YYYY-MM-DD, which is what a <input type="date"> wants. */
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function SalariesPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    userId:        "",
    baseAmount:    "",
    allowances:    [] as SalaryComponent[],
    deductions:    [] as SalaryComponent[],
    effectiveFrom: todayISO(),
  });

  const staffQ = useQuery({
    queryKey: ["finance", "staff", schoolId],
    queryFn:  () => fetchStaff(schoolId),
    enabled:  !!schoolId,
  });

  const structuresQ = useQuery({
    queryKey: ["finance", "salaries", schoolId],
    queryFn:  () => fetchSalaryStructures(schoolId),
    enabled:  !!schoolId,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      createSalaryStructure({
        schoolId,
        userId:     form.userId,
        baseAmount: Number(form.baseAmount),
        // Blank rows are the natural residue of an "add row" button; drop them
        // rather than making the server reject the whole submission.
        allowances: form.allowances.filter((c) => c.code.trim() && c.label.trim()),
        deductions: form.deductions.filter((c) => c.code.trim() && c.label.trim()),
        effectiveFrom: form.effectiveFrom,
      }),
    onSuccess: () => {
      setOpen(false);
      setForm({
        userId: "", baseAmount: "", allowances: [], deductions: [],
        effectiveFrom: todayISO(),
      });
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (err) =>
      toast({ kind: "error", title: t("salaries.setSalary"), message: getErrorMessage(err) }),
  });

  if (structuresQ.isLoading) return <PageSpinner />;

  const staff      = staffQ.data ?? [];
  const structures = structuresQ.data ?? [];
  const staffById  = new Map(staff.map((s) => [s._id, s]));

  const base       = Number(form.baseAmount) || 0;
  const allowTotal = form.allowances.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const dedTotal   = form.deductions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const gross      = base + allowTotal;
  const net        = gross - dedTotal;

  const baseValid = Number.isInteger(Number(form.baseAmount)) && Number(form.baseAmount) > 0;

  const setComponent = (
    kind: "allowances" | "deductions",
    index: number,
    patch: Partial<SalaryComponent>
  ) =>
    setForm((f) => ({
      ...f,
      [kind]: f[kind].map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));

  const removeComponent = (kind: "allowances" | "deductions", index: number) =>
    setForm((f) => ({ ...f, [kind]: f[kind].filter((_, i) => i !== index) }));

  const componentRows = (kind: "allowances" | "deductions") => (
    <div className="space-y-2">
      {form[kind].map((c, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              placeholder={t("expenses.categoryCode")}
              value={c.code}
              onChange={(e) => setComponent(kind, i, { code: e.target.value })}
            />
          </div>
          <div className="flex-[1.4]">
            <Input
              placeholder={t("fees.itemLabel")}
              value={c.label}
              onChange={(e) => setComponent(kind, i, { label: e.target.value })}
            />
          </div>
          <div className="w-32">
            <Input
              type="number" step="1" min="0" inputMode="numeric"
              value={String(c.amount)}
              onChange={(e) => setComponent(kind, i, { amount: Number(e.target.value) || 0 })}
            />
          </div>
          <button
            type="button"
            onClick={() => removeComponent(kind, i)}
            aria-label={t("common.delete")}
            className="mb-1 rounded-control p-2 text-ink-faint transition-colors hover:bg-canvas hover:text-danger"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon={<Plus className="h-4 w-4" />}
        onClick={() =>
          setForm((f) => ({ ...f, [kind]: [...f[kind], emptyComponent()] }))
        }
      >
        {kind === "allowances" ? t("salaries.addAllowance") : t("salaries.addDeduction")}
      </Button>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("salaries.title")}
        description={t("salaries.blurb")}
        actions={
          <Button
            icon={<Wallet className="h-4 w-4" />}
            onClick={() => setOpen(true)}
            disabled={staff.length === 0}
          >
            {t("salaries.setSalary")}
          </Button>
        }
      />

      <Card padding={false}>
        {structures.length === 0 ? (
          <EmptyTable title={t("salaries.none")} subtitle={t("salaries.noneHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("salaries.staff")}</Th>
                <Th numeric>{t("salaries.base")}</Th>
                <Th numeric>{t("salaries.allowances")}</Th>
                <Th numeric>{t("salaries.deductions")}</Th>
                <Th numeric>{t("salaries.net")}</Th>
                <Th>{t("salaries.effectiveFrom")}</Th>
              </Tr>
            </THead>
            <TBody>
              {structures.map((s) => {
                const a = s.allowances.reduce((sum, c) => sum + c.amount, 0);
                const d = s.deductions.reduce((sum, c) => sum + c.amount, 0);
                return (
                  <Tr key={s._id}>
                    <Td className="font-medium text-ink">
                      {s.staff?.name ?? staffById.get(s.userId)?.name ?? s.userId}
                    </Td>
                    <Td numeric className="text-ink-muted">{fmt.money(s.baseAmount)}</Td>
                    <Td numeric className="text-ink-muted">{a ? fmt.money(a) : "—"}</Td>
                    <Td numeric className="text-ink-muted">{d ? fmt.money(d) : "—"}</Td>
                    <Td numeric className="font-semibold text-ink">
                      {fmt.money(s.baseAmount + a - d)}
                    </Td>
                    <Td className="text-ink-muted">{fmt.dateShort(s.effectiveFrom)}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title={t("salaries.setSalary")} size="lg">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.userId && baseValid) saveMutation.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label={t("salaries.staff")} required>
              <SelectField
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                placeholder={t("salaries.staff")}
                options={staff.map((s) => ({ value: s._id, label: s.name }))}
              />
            </FormField>
            <FormField
              label={t("salaries.effectiveFrom")}
              required
              hint={t("salaries.replaceWarning")}
            >
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
              />
            </FormField>
          </div>

          <FormField label={t("salaries.base")} required hint={t("fees.amountHint")}>
            <Input
              type="number" step="1" min="1" inputMode="numeric"
              value={form.baseAmount}
              invalid={form.baseAmount !== "" && !baseValid}
              onChange={(e) => setForm((f) => ({ ...f, baseAmount: e.target.value }))}
            />
          </FormField>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("salaries.allowances")}
            </p>
            {componentRows("allowances")}
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("salaries.deductions")}
            </p>
            {componentRows("deductions")}
          </div>

          {/* The figure that will actually be paid, before it is saved. */}
          <div className="flex flex-wrap gap-6 rounded-card border border-line bg-canvas px-4 py-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {t("salaries.gross")}
              </p>
              <p className="mt-1 text-lg font-semibold text-ink tabular">{fmt.money(gross)}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {t("salaries.deductions")}
              </p>
              <p className="mt-1 text-lg font-semibold text-ink-muted tabular">{fmt.money(dedTotal)}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {t("salaries.net")}
              </p>
              <p className="mt-1 text-lg font-semibold text-primary tabular">{fmt.money(net)}</p>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={saveMutation.isPending}
              disabled={!form.userId || !baseValid}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
