// web/src/pages/settings/ApprovalsSection.tsx
//
// Where a school turns segregation of duties on.
//
// ── Off by default, and this screen has to say why ────────────────────────
//
// Every threshold ships empty, meaning no second signature is ever required.
// That is not timidity: switching approvals on for every school at once would
// mean that on the morning after an upgrade no bursar could record the day's
// cash expenses until a head teacher signed in. What follows is not adoption of
// the discipline — it is somebody turning the whole thing off, or sharing an
// admin password, and then there is no separation at all and nobody knows.
//
// So the default is off, and the screen's job is to make turning it on obvious
// and to explain what each number buys. A recommended figure is offered rather
// than imposed, because the right threshold in a school where a term's fees are
// 45,000 FCFA is not the right one in a school where they are 450,000.
//
// ── Empty and zero are different ──────────────────────────────────────────
//
// Empty means never. Zero means always. Both are real answers and the field
// distinguishes them, which is why the inputs are text rather than numbers with
// a 0 default — a number input that coerces "" to 0 would silently turn "never"
// into "every single time".

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Save, Info } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { FormField, Input, Checkbox } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { useFormat } from "@/i18n/format";
import { getErrorMessage } from "@/lib/axios";
import {
  fetchApprovalSummary, saveThresholds,
  type ApprovalThresholds,
} from "@/services/approval.service";

/** What the fields hold while being typed: "" means never. */
interface Draft {
  expenseThreshold: string;
  refundThreshold:  string;
  waiverThreshold:  string;
  payrollRequired:  boolean;
}

const toDraft = (t: ApprovalThresholds): Draft => ({
  expenseThreshold: t.expenseThreshold === null ? "" : String(t.expenseThreshold),
  refundThreshold:  t.refundThreshold  === null ? "" : String(t.refundThreshold),
  waiverThreshold:  t.waiverThreshold  === null ? "" : String(t.waiverThreshold),
  payrollRequired:  t.payrollRequired,
});

const parse = (v: string): number | null => {
  const s = v.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : NaN;
};

export default function ApprovalsSection({ schoolId }: { schoolId: string }) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();
  const fmt       = useFormat();

  /** Edits, absent until something is typed — no effect copying server state. */
  const [draft, setDraft] = useState<Draft | null>(null);

  const query = useQuery({
    queryKey: ["approvals", "summary", schoolId],
    queryFn:  () => fetchApprovalSummary(schoolId),
    enabled:  Boolean(schoolId),
  });

  const saved = useMemo(
    () => (query.data ? toDraft(query.data.thresholds) : null),
    [query.data]
  );

  const form = draft ?? saved;

  const dirty = useMemo(() => {
    if (!draft || !saved) return false;
    return (
      draft.expenseThreshold !== saved.expenseThreshold ||
      draft.refundThreshold  !== saved.refundThreshold  ||
      draft.waiverThreshold  !== saved.waiverThreshold  ||
      draft.payrollRequired  !== saved.payrollRequired
    );
  }, [draft, saved]);

  const invalid = useMemo(() => {
    if (!form) return false;
    return [form.expenseThreshold, form.refundThreshold, form.waiverThreshold]
      .some((v) => Number.isNaN(parse(v)));
  }, [form]);

  const set = (patch: Partial<Draft>) =>
    setDraft((prev) => ({ ...(prev ?? saved!), ...patch }));

  const mutation = useMutation({
    mutationFn: async (next: Draft) =>
      saveThresholds(schoolId, {
        expenseThreshold: parse(next.expenseThreshold) as number | null,
        refundThreshold:  parse(next.refundThreshold)  as number | null,
        waiverThreshold:  parse(next.waiverThreshold)  as number | null,
        payrollRequired:  next.payrollRequired,
      }),
    onSuccess: async () => {
      toast({ kind: "success", title: t("approvalSettings.saved") });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (err) => {
      toast({
        kind: "error", title: t("approvalSettings.saveFailed"),
        message: getErrorMessage(err),
      });
    },
  });

  if (query.isLoading) return <PageSpinner />;
  if (!form) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">{t("approvalSettings.unavailable")}</p>
      </Card>
    );
  }

  const anyOn =
    parse(form.expenseThreshold) !== null ||
    parse(form.refundThreshold)  !== null ||
    parse(form.waiverThreshold)  !== null ||
    form.payrollRequired;

  const field = (
    key: "expenseThreshold" | "refundThreshold" | "waiverThreshold"
  ) => {
    const raw    = form[key];
    const value  = parse(raw);
    const broken = Number.isNaN(value);

    return (
      <FormField
        label={t(`approvalSettings.${key}`)}
        hint={
          broken
            ? undefined
            : value === null
              ? t("approvalSettings.never")
              : value === 0
                ? t("approvalSettings.always")
                : t("approvalSettings.atOrAbove", { amount: fmt.money(value) })
        }
        error={broken ? t("approvalSettings.invalid") : undefined}
      >
        <Input
          value={raw}
          inputMode="numeric"
          placeholder={t("approvalSettings.neverPlaceholder")}
          onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
          invalid={broken}
        />
      </FormField>
    );
  };

  return (
    <div className="space-y-5">

      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50">
            <ShieldCheck className="h-4 w-4 text-primary-600" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">
              {t("approvalSettings.title")}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              {t("approvalSettings.intro")}
            </p>

            {/* The rule that makes any of it worth setting. */}
            <p className="mt-2 text-xs text-ink-faint">
              {t("approvalSettings.fourEyes")}
            </p>
          </div>
        </div>
      </Card>

      {!anyOn && (
        <div className="flex items-start gap-2 rounded-card border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("approvalSettings.allOff")}</span>
        </div>
      )}

      <Card>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("approvalSettings.amounts")}
        </h3>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {field("expenseThreshold")}
          {field("refundThreshold")}
          {field("waiverThreshold")}
        </div>

        <p className="mt-3 text-xs text-ink-faint">
          {t("approvalSettings.recommendation")}
        </p>
      </Card>

      <Card>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("approvalSettings.payroll")}
        </h3>

        <div className="mt-3">
          <Checkbox
            checked={form.payrollRequired}
            onChange={(e) => set({ payrollRequired: e.target.checked })}
            label={t("approvalSettings.payrollRequired")}
          />
        </div>

        <p className="mt-2 text-xs text-ink-faint">
          {t("approvalSettings.payrollHint")}
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => form && mutation.mutate(form)}
          disabled={!dirty || invalid || mutation.isPending}
          icon={<Save className="h-4 w-4" />}
        >
          {mutation.isPending ? t("common.saving") : t("common.save")}
        </Button>

        <Button
          variant="secondary"
          disabled={!dirty || mutation.isPending}
          onClick={() => setDraft(null)}
        >
          {t("common.cancel")}
        </Button>

        {dirty && (
          <span className="text-xs text-ink-faint">
            {t("approvalSettings.takesEffect")}
          </span>
        )}
      </div>
    </div>
  );
}
