// web/src/pages/settings/CalculationRulesSection.tsx
//
// A school's calculation rules for one academic year (docs/39 Phase 5,
// §20.2; the rules themselves: shared/academicRules.js, Phase 4).
//
// ── Every rule here changes real results ──────────────────────────────────
//
// Which sequence average is official, whose bands a term row stores, how
// promotion is proposed, whether published results may be recomputed — each
// is a decision for the school's authorised academic review (docs/39 §21.1),
// so each is offered, never assumed. The default of every rule is how results
// were computed before this screen existed, and it is marked as such.
//
// ── Nothing is saved without its consequence stated ───────────────────────
//
// Save asks the server what the change would do (POST …/rules/preview) and
// shows it — which rules move, which results each reaches, how many results
// are already published (they keep their figures) and how many unpublished
// ones will follow the new rule when next computed — and asks for a reason,
// which goes into the audit trail with the before and after.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Calculator, Info, Save } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { PageSpinner } from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { getErrorMessage } from "@/lib/axios";
import { fetchClasses } from "@/services/class.service";
import {
  fetchRules, previewRules, saveRules, RULE_KEYS,
  type AcademicRules, type RuleKey, type RulesPreview, type RulesImpact,
} from "@/services/academicRules.service";

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

/** A threshold as typed: "" is none. */
const parseBar = (raw: string): number | null => {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : NaN;
};
const barText = (n: number | null | undefined) => (n == null ? "" : String(n));

interface Draft {
  rules: Omit<AcademicRules, "promotionThreshold" | "classThresholds">;
  promotionThreshold: string;
  classThresholds:    Record<string, string>;
}

const toDraft = (r: AcademicRules): Draft => ({
  rules: {
    sequenceAverage:  r.sequenceAverage,
    gradingAuthority: r.gradingAuthority,
    promotionRule:    r.promotionRule,
    publishedResults: r.publishedResults,
  },
  promotionThreshold: barText(r.promotionThreshold),
  classThresholds: Object.fromEntries(Object.entries(r.classThresholds ?? {}).map(([k, v]) => [k, barText(v)])),
});

/** The draft as the API takes it; NaN marks an invalid field. */
const fromDraft = (d: Draft): AcademicRules => {
  const classThresholds: Record<string, number> = {};
  for (const [id, raw] of Object.entries(d.classThresholds)) {
    const v = parseBar(raw);
    if (v !== null) classThresholds[id] = v;
  }
  return { ...d.rules, promotionThreshold: parseBar(d.promotionThreshold), classThresholds };
};

const totals = (impact: RulesImpact) => ({
  published:   impact.sequence.published + impact.term.published + impact.annual.published,
  unpublished: impact.sequence.unpublished + impact.term.unpublished + impact.annual.unpublished,
});

export default function CalculationRulesSection({ schoolId }: { schoolId: string }) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();

  const [year, setYear]       = useState(ACADEMIC_YEARS[1]);
  const [draft, setDraft]     = useState<Draft | null>(null);
  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const [reason, setReason]   = useState("");

  const query = useQuery({
    queryKey: ["academicRules", schoolId, year],
    queryFn:  () => fetchRules(schoolId, year),
    enabled:  Boolean(schoolId),
  });
  const classesQuery = useQuery({
    queryKey: ["academicRules", "classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  Boolean(schoolId),
  });

  const saved = useMemo(() => (query.data ? toDraft(query.data.rules) : null), [query.data]);
  const form  = draft ?? saved;

  const next  = useMemo(() => (form ? fromDraft(form) : null), [form]);
  const dirty = useMemo(() => {
    if (!draft || !saved) return false;
    return JSON.stringify(fromDraft(draft)) !== JSON.stringify(fromDraft(saved));
  }, [draft, saved]);

  const errors = useMemo(() => {
    if (!next) return {} as Record<string, string>;
    const e: Record<string, string> = {};
    if (Number.isNaN(next.promotionThreshold)) e.promotionThreshold = t("academicRules.barInvalid");
    for (const [id, raw] of Object.entries(form?.classThresholds ?? {})) {
      if (Number.isNaN(parseBar(raw))) e[`class:${id}`] = t("academicRules.barInvalid");
    }
    if (next.promotionRule === "annual_average_at_least" && next.promotionThreshold === null) {
      e.promotionThreshold = t("academicRules.barRequired");
    }
    return e;
  }, [next, form, t]);
  const invalid = Object.keys(errors).length > 0;

  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...(prev ?? saved!), ...patch }));
  const setRule = (key: RuleKey, value: string) =>
    set({ rules: { ...(draft ?? saved!).rules, [key]: value } as Draft["rules"] });

  const review = useMutation({
    mutationFn: () => previewRules(schoolId, year, next!),
    onSuccess: (p) => { setReason(""); setPreview(p); },
    onError: (err) => toast({ kind: "error", title: t("academicRules.previewFailed"), message: getErrorMessage(err) }),
  });

  const save = useMutation({
    mutationFn: () => saveRules(schoolId, year, next!, reason.trim() || null),
    onSuccess: async () => {
      toast({ kind: "success", title: t("academicRules.saved") });
      setPreview(null);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["academicRules", schoolId] });
    },
    onError: (err) => toast({ kind: "error", title: t("academicRules.saveFailed"), message: getErrorMessage(err) }),
  });

  if (query.isLoading) return <PageSpinner />;
  if (!form || !query.data) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          {query.error ? getErrorMessage(query.error) : t("academicRules.unavailable")}
        </p>
      </Card>
    );
  }

  const { definitions, impact } = query.data;
  const sum = totals(impact);
  const classes = classesQuery.data ?? [];

  const valueLabel = (rule: string, value: unknown) => {
    if (rule === "promotionThreshold") return value == null ? t("academicRules.none") : String(value);
    if (rule === "classThresholds") {
      const n = Object.keys((value as Record<string, number>) ?? {}).length;
      return t("academicRules.classBars", { count: n });
    }
    return t(`academicRules.value.${String(value)}.label`);
  };

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50">
            <Calculator className="h-4 w-4 text-primary-600" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t("academicRules.title")}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t("academicRules.intro")}</p>
          </div>
          <div className="w-40 shrink-0">
            <SelectField
              aria-label={t("academicRules.year")}
              value={year}
              onChange={(e) => { setYear(e.target.value); setDraft(null); }}
              options={ACADEMIC_YEARS.map((y) => ({ value: y, label: y }))}
            />
          </div>
        </div>
      </Card>

      {query.data.isDefault && (
        <div className="flex items-start gap-2 rounded-card border border-line bg-canvas px-4 py-3 text-sm text-ink-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("academicRules.onDefaults")}</span>
        </div>
      )}

      <Card>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("academicRules.impactTitle")}</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          {(["sequence", "term", "annual"] as const).map((k) => (
            <div key={k} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="text-xs text-ink-faint">{t(`academicRules.affects.${k}`)}</div>
              <div className="mt-1 text-ink">
                {t("academicRules.counts", { published: impact[k].published, unpublished: impact[k].unpublished })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {RULE_KEYS.map((key) => {
        const def = definitions[key];
        const current = form.rules[key];
        return (
          <Card key={key}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">{t(`academicRules.rule.${key}.title`)}</h3>
              <Badge variant="secondary">{t("academicRules.decision", { id: def.decision })}</Badge>
            </div>
            <p className="mt-1 text-sm text-ink-muted">{t(`academicRules.rule.${key}.desc`)}</p>

            <div className="mt-3 space-y-2" role="radiogroup" aria-label={t(`academicRules.rule.${key}.title`)}>
              {def.values.map((value) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                    current === value ? "border-primary-300 bg-primary-50" : "border-gray-100 bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name={`rule-${key}`}
                    className="mt-1"
                    checked={current === value}
                    onChange={() => setRule(key, value)}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      {t(`academicRules.value.${value}.label`)}
                      {value === def.default && <Badge variant="default">{t("academicRules.currentBehaviour")}</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{t(`academicRules.value.${value}.desc`)}</span>
                  </span>
                </label>
              ))}
            </div>

            {key === "promotionRule" && form.rules.promotionRule === "annual_average_at_least" && (
              <div className="mt-4 space-y-3">
                <FormField label={t("academicRules.schoolBar")} hint={t("academicRules.barHint")} error={errors.promotionThreshold}>
                  <Input
                    value={form.promotionThreshold}
                    inputMode="decimal"
                    onChange={(e) => set({ promotionThreshold: e.target.value })}
                    invalid={Boolean(errors.promotionThreshold)}
                  />
                </FormField>
                {classes.length > 0 && (
                  <div>
                    <p className="text-xs text-ink-faint">{t("academicRules.classBarsHint")}</p>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {classes.map((c) => (
                        <FormField key={c._id} label={c.name} error={errors[`class:${c._id}`]}>
                          <Input
                            value={form.classThresholds[c._id] ?? ""}
                            inputMode="decimal"
                            placeholder={t("academicRules.sameAsSchool")}
                            onChange={(e) => set({ classThresholds: { ...form.classThresholds, [c._id]: e.target.value } })}
                            invalid={Boolean(errors[`class:${c._id}`])}
                          />
                        </FormField>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => review.mutate()}
          disabled={!dirty || invalid || review.isPending}
          icon={<Save className="h-4 w-4" />}
        >
          {review.isPending ? t("common.saving") : t("academicRules.review")}
        </Button>
        <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(null)}>
          {t("common.cancel")}
        </Button>
        {dirty && <span className="text-xs text-ink-faint">{t("academicRules.takesEffect")}</span>}
      </div>

      <Modal
        open={preview !== null}
        onClose={() => !save.isPending && setPreview(null)}
        title={t("academicRules.confirmTitle", { year })}
        closeOnBackdrop={false}
        size="lg"
      >
        {preview && (
          <div className="space-y-4 text-sm">
            <ul className="space-y-2">
              {preview.changes.map((c) => (
                <li key={c.rule} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                  <div className="font-medium text-ink">{t(`academicRules.rule.${c.rule}.title`)}</div>
                  <div className="text-ink-muted">
                    {t("academicRules.fromTo", { from: valueLabel(c.rule, c.from), to: valueLabel(c.rule, c.to) })}
                  </div>
                  {c.affects.length > 0 && (
                    <div className="mt-1 text-xs text-ink-faint">
                      {t("academicRules.reaches", { what: c.affects.map((a) => t(`academicRules.affects.${a}`)).join(", ") })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-ink">
              {t("academicRules.consequence", { published: totals(preview.impact).published, unpublished: totals(preview.impact).unpublished })}
            </p>
            {preview.impact.draftPromotionRuns > 0 && preview.changes.some((c) => c.affects.includes("promotion")) && (
              <p className="rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-warning">
                {t("academicRules.draftRunBlocks")}
              </p>
            )}
            <FormField label={t("academicRules.reason")} hint={t("academicRules.reasonHint")}>
              <Textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" disabled={save.isPending} onClick={() => setPreview(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => save.mutate()} loading={save.isPending}>
                {t("academicRules.confirm")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <p className="text-xs text-ink-faint">{t("academicRules.totals", { published: sum.published, unpublished: sum.unpublished })}</p>
    </div>
  );
}
