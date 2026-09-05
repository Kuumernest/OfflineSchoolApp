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
import { Plus, Trash2, Wallet, Pencil } from "lucide-react";

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
import { getErrorMessage }  from "@/lib/axios";
import { usePermission }    from "@/lib/permissions";
import {
  fetchStaff, fetchSalaryStructures, createSalaryStructure, updateSalaryStructure,
} from "@/services/finance.service";
import type { SalaryComponent, PayType, SalaryStructure } from "@/types/finance.types";

const emptyComponent = (): SalaryComponent => ({ code: "", label: "", amount: 0 });

/** Today as YYYY-MM-DD, which is what a <input type="date"> wants. */
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function SalariesPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const canSetSalary = usePermission("payroll.setSalary");
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [open, setOpen] = useState(false);
  // The structure being corrected, or null when setting a new one. The
  // difference is not cosmetic: an edit rewrites the row in force, a new one
  // closes it and opens the next, and only the second is a raise.
  const [editing, setEditing] = useState<SalaryStructure | null>(null);
  const [form, setForm] = useState({
    userId:        "",
    payType:       "monthly" as PayType,
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

  const blankForm = () => ({
    userId: "", payType: "monthly" as PayType, baseAmount: "",
    allowances: [] as SalaryComponent[], deductions: [] as SalaryComponent[],
    effectiveFrom: todayISO(),
  });

  const openNew = () => {
    setEditing(null);
    setForm(blankForm());
    setOpen(true);
  };

  /**
   * Open the dialog on an existing salary, filled in.
   *
   * Filled in, because the request this becomes only carries what is on the
   * form — so an empty dialog would turn "add one deduction" into "replace the
   * whole salary with one deduction and nothing else".
   */
  const openEdit = (s: SalaryStructure) => {
    setEditing(s);
    setForm({
      userId:        s.userId,
      payType:       (s.payType ?? "monthly") as PayType,
      baseAmount:    String(s.baseAmount),
      allowances:    s.allowances.map((c) => ({ ...c })),
      deductions:    s.deductions.map((c) => ({ ...c })),
      effectiveFrom: String(s.effectiveFrom).slice(0, 10),
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      // Blank rows are the natural residue of an "add row" button; drop them
      // rather than making the server reject the whole submission.
      const allowances = form.allowances.filter((c) => c.code.trim() && c.label.trim());
      const deductions = form.deductions.filter((c) => c.code.trim() && c.label.trim());

      if (editing) {
        return updateSalaryStructure(editing._id, {
          schoolId,
          payType:       form.payType,
          baseAmount:    Number(form.baseAmount),
          allowances,
          deductions,
          effectiveFrom: form.effectiveFrom,
        });
      }

      return createSalaryStructure({
        schoolId,
        userId:     form.userId,
        payType:    form.payType,
        baseAmount: Number(form.baseAmount),
        allowances,
        deductions,
        effectiveFrom: form.effectiveFrom,
      });
    },
    onSuccess: () => {
      setOpen(false);
      setEditing(null);
      setForm(blankForm());
      void qc.invalidateQueries({ queryKey: ["finance"] });
    },
    onError: (err) =>
      toast({
        kind: "error",
        title: editing ? t("salaries.editSalary") : t("salaries.setSalary"),
        // The server explains the two refusals it can give — already paid, or
        // superseded — and both name the thing to do instead. Passing that
        // through beats a generic failure the bursar cannot act on.
        message: getErrorMessage(err),
      }),
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
        meta={
          /*
            The bursar reaches this page because they cannot prepare a payroll
            without reading what staff are owed. Setting the figure is somebody
            else's decision — POST /finance/salary-structures requires
            payroll.setSalary, which is non-delegable — so the button below is
            disabled for them rather than absent, with the reason said out loud.

            Absent would have been easier and worse: a bursar who cannot find
            the control assumes the page is broken and asks. A disabled control
            with a sentence next to it answers the question where it is asked.
          */
          !canSetSalary ? <span>{t("salaries.readOnlyNote")}</span> : undefined
        }
        actions={
          <Button
            icon={<Wallet className="h-4 w-4" />}
            onClick={openNew}
            disabled={staff.length === 0 || !canSetSalary}
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
                <Th />
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
                    <Td numeric className="text-ink-muted">
                      {fmt.money(s.baseAmount)}
                      {(s.payType ?? "monthly") === "hourly" && (
                        <span className="ml-1 text-[11px] uppercase tracking-wide text-ink-faint">
                          {t("salaries.perHour")}
                        </span>
                      )}
                    </Td>
                    <Td numeric className="text-ink-muted">{a ? fmt.money(a) : "—"}</Td>
                    <Td numeric className="text-ink-muted">{d ? fmt.money(d) : "—"}</Td>
                    <Td numeric className="font-semibold text-ink">
                      {fmt.money(s.baseAmount + a - d)}
                    </Td>
                    <Td className="text-ink-muted">{fmt.dateShort(s.effectiveFrom)}</Td>
                    <Td numeric>
                      {/* Only on the row in force. A superseded structure is
                          closed history and the server refuses to edit it, so
                          offering the button would be offering a 409. */}
                      {canSetSalary && !s.effectiveTo && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Pencil className="h-3.5 w-3.5" />}
                          onClick={() => openEdit(s)}
                        >
                          {t("common.edit")}
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => { setOpen(false); setEditing(null); }}
        title={editing ? t("salaries.editSalary") : t("salaries.setSalary")}
        size="lg"
      >
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
                /* Locked while correcting: the endpoint takes no userId, so
                   changing it here would move nothing and say it had. Moving a
                   salary to somebody else is a new salary for them. */
                disabled={Boolean(editing)}
              />
            </FormField>
            <FormField
              label={t("salaries.effectiveFrom")}
              required
              hint={editing ? t("salaries.editHint") : t("salaries.replaceWarning")}
            >
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
              />
            </FormField>
          </div>

          <FormField label={t("salaries.payType")} required>
            <SelectField
              value={form.payType}
              onChange={(e) => setForm((f) => ({ ...f, payType: e.target.value as PayType }))}
              options={[
                { value: "monthly", label: t("salaries.payTypeMonthly") },
                { value: "hourly",  label: t("salaries.payTypeHourly") },
              ]}
            />
          </FormField>

          <FormField
            label={form.payType === "hourly" ? t("salaries.baseHourly") : t("salaries.baseMonthly")}
            required
            hint={
              form.payType === "hourly"
                ? t("salaries.hourlyHint")
                : t("fees.amountHint")
            }
          >
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
          {form.payType === "hourly" && (
            <p className="-mt-2 text-xs text-ink-faint">{t("salaries.hourlyPreviewNote")}</p>
          )}

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
