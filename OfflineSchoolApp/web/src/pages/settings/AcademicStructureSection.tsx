// web/src/pages/settings/AcademicStructureSection.tsx
import { useState, useEffect, useCallback } from "react";
import {
  Calendar, Save, Loader2, AlertCircle, ChevronDown, ChevronUp, Plus, Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useToast } from "@/components/ui/Toast";
import api from "@/services/api";
import { cn } from "@/utils/cn";
import type {
  AcademicStructure,
  TermConfig,
  SequenceConfig,
  SequenceNumber,
  TermNumber,
} from "@/types/exam.types";

// ─────────────────────────────────────────────────────────
// INLINE UI PRIMITIVES (same as SettingsPage)
// ─────────────────────────────────────────────────────────

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-gray-200 bg-white p-6 shadow-sm", className)}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-gray-900 mb-4">{children}</h3>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-gray-700 mb-1">{children}</label>;
}

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

const DEFAULT_TERMS: TermConfig[] = [
  {
    number: 1, name: "1st Term", weight: 33.33,
    sequences: [
      { number: 1, name: "Sequence 1", weight: 50, assessment: { type: "test", label: "Test 1" } },
      { number: 2, name: "Sequence 2", weight: 50, assessment: { type: "test", label: "Test 2" } },
    ],
  },
  {
    number: 2, name: "2nd Term", weight: 33.33,
    sequences: [
      { number: 3, name: "Sequence 3", weight: 50, assessment: { type: "test", label: "Test 3" } },
      { number: 4, name: "Sequence 4", weight: 50, assessment: { type: "test", label: "Test 4" } },
    ],
  },
  {
    number: 3, name: "3rd Term", weight: 33.34,
    sequences: [
      { number: 5, name: "Sequence 5", weight: 50, assessment: { type: "test", label: "Test 5" } },
      { number: 6, name: "Sequence 6", weight: 50, assessment: { type: "test", label: "Test 6" } },
    ],
  },
];

const SEQUENCE_NAMES: Record<SequenceNumber, string> = {
  1: "Seq 1", 2: "Seq 2", 3: "Seq 3", 4: "Seq 4", 5: "Seq 5", 6: "Seq 6",
};

const ASSESSMENT_TYPES = ["test", "practical", "promotion_exam"] as const;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const extractMessage = (err: unknown): string => {
  const data = (err as { response?: { data?: { message?: string; error?: string; errors?: Array<{ message?: string }> } } })
    ?.response?.data;
  return data?.message ?? data?.error ?? data?.errors?.[0]?.message ??
    (err instanceof Error ? err.message : i18n.t("settings.somethingWrong"));
};

// The bounds every stored exam and result already lives in (docs/39 Phase 6,
// shared/periodStructure.js on the server, which enforces the same).
const MAX_TERMS = 3;
const MAX_SEQUENCES = 6;
/** A number no real sequence has, for one just added and not yet renumbered. */
const NEW_SEQUENCE = 99 as SequenceNumber;

/**
 * Terms numbered 1..n and sequences 1..m across the whole year, in order —
 * the shape the server accepts — with the promotion exams following their
 * sequences to their new numbers. For the standard three-by-two year this
 * changes nothing.
 */
function reshape(terms: TermConfig[], promotionExams: number[] | undefined) {
  let n = 0;
  const moved = new Map<number, number>();
  const out = terms.map((t, i) => ({
    ...t,
    number: (i + 1) as TermNumber,
    sequences: t.sequences.map((sq) => {
      n += 1;
      if (sq.number !== NEW_SEQUENCE) moved.set(sq.number, n);
      return { ...sq, number: n as SequenceNumber };
    }),
  }));
  const promo = (promotionExams ?? []).filter((p) => moved.has(p)).map((p) => moved.get(p)!) as SequenceNumber[];
  return { terms: out, promotionExams: promo };
}

/** Ensure a structure matches current schema defaults (migration-safe). */
function normalise(raw: AcademicStructure): AcademicStructure {
  // Sequences are numbered across the whole year (1..m), not "two per term":
  // a year may have three evaluations in a semester (docs/39 Phase 6). For
  // the standard year the numbers are the ones it always had.
  let seq = 0;
  const terms = (raw.terms ?? DEFAULT_TERMS).map((t, i) => ({
    ...t,
    number: (i + 1) as TermNumber,
    sequences: (t.sequences ?? []).map((s) => {
      seq += 1;
      return {
        ...s,
        number: seq as SequenceNumber,
        weight: s.weight ?? 50,
        assessment: s.assessment ?? { type: "test" as const },
      };
    }),
  }));
  return { ...raw, terms };
}

// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────

interface Props {
  schoolId: string;
}

export default function AcademicStructureSection({ schoolId }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [academicYear, setAcademicYear] = useState(ACADEMIC_YEARS[1]);
  const [structure, setStructure] = useState<AcademicStructure | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedTerm, setExpandedTerm] = useState<number | null>(1);

  // ── Load ──
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`);
      setStructure(normalise(data.structure));
    } catch (err) {
      toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err) });
    } finally {
      setLoading(false);
    }
  }, [schoolId, academicYear, t, toast]);

  // load is useCallback([schoolId, academicYear, t, toast]); toast comes from a
  // useMemo'd context whose two callbacks are useCallback([]), so the identity is
  // stable and this cannot re-run itself.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  // ── Save ──
  const handleSave = async () => {
    if (!structure) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`, {
        terms: structure.terms,
        promotionExams: structure.promotionExams,
        passMark: structure.passMark,
        maxAbsences: structure.maxAbsences,
      });
      setStructure(normalise(data.structure));
      toast({ kind: "success", title: t("academicStructure.saved") });
    } catch (err) {
      toast({ kind: "error", title: t("settings.saveFailed"), message: extractMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  // ── Mutators ──
  const updateTerm = (idx: number, patch: Partial<TermConfig>) => {
    if (!structure) return;
    const terms = [...structure.terms];
    terms[idx] = { ...terms[idx], ...patch };
    setStructure({ ...structure, terms });
  };

  const updateSequence = (termIdx: number, seqIdx: number, patch: Partial<SequenceConfig>) => {
    if (!structure) return;
    const terms = [...structure.terms];
    const sequences = [...terms[termIdx].sequences];
    sequences[seqIdx] = { ...sequences[seqIdx], ...patch };
    terms[termIdx] = { ...terms[termIdx], sequences };
    setStructure({ ...structure, terms });
  };

  // ── Shaping the year (docs/39 Phase 6) ──
  const totalSequences = structure?.terms.reduce((n, tm) => n + tm.sequences.length, 0) ?? 0;
  const applyShape = (terms: TermConfig[]) => {
    if (!structure) return;
    setStructure({ ...structure, ...reshape(terms, structure.promotionExams) });
  };
  const newSequence = (): SequenceConfig => ({
    number: NEW_SEQUENCE,
    name: t("academicStructure.newSequenceName", { n: totalSequences + 1 }),
    weight: 50,
    assessment: { type: "test" },
  } as SequenceConfig);
  const addTerm = () => {
    if (!structure || structure.terms.length >= MAX_TERMS || totalSequences >= MAX_SEQUENCES) return;
    applyShape([...structure.terms, {
      number: (structure.terms.length + 1) as TermNumber,
      name: t("academicStructure.newTermName", { n: structure.terms.length + 1 }),
      weight: 0,
      sequences: [newSequence()],
    } as TermConfig]);
  };
  const removeTerm = (termIdx: number) => {
    if (!structure || structure.terms.length <= 1) return;
    applyShape(structure.terms.filter((_, i) => i !== termIdx));
  };
  const addSequence = (termIdx: number) => {
    if (!structure || totalSequences >= MAX_SEQUENCES) return;
    applyShape(structure.terms.map((tm, i) => (i === termIdx ? { ...tm, sequences: [...tm.sequences, newSequence()] } : tm)));
  };
  const removeSequence = (termIdx: number, seqIdx: number) => {
    if (!structure || structure.terms[termIdx].sequences.length <= 1) return;
    applyShape(structure.terms.map((tm, i) => (i === termIdx ? { ...tm, sequences: tm.sequences.filter((_, j) => j !== seqIdx) } : tm)));
  };

  const togglePromotionExam = (seqNum: SequenceNumber) => {
    if (!structure) return;
    const current = structure.promotionExams ?? [];
    const next = current.includes(seqNum)
      ? current.filter((n) => n !== seqNum)
      : [...current, seqNum];
    setStructure({ ...structure, promotionExams: next });
  };

  // ── Derived ──
  const termWeightSum = structure?.terms.reduce((s, t) => s + (t.weight ?? 0), 0) ?? 0;
  const weightsValid = Math.abs(termWeightSum - 100) < 0.5;

  // ── Render ──
  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!structure) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-amber-600">
          <AlertCircle className="h-5 w-5" />
          <p className="text-sm">{t("academicStructure.loadFailed")}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Academic Year Selector ── */}
      <Card>
        <CardTitle>{t("academicStructure.title")}</CardTitle>
        <p className="text-xs text-gray-500 mb-4">
          {t("academicStructure.description")}
        </p>

        <div className="flex items-center gap-3">
          <FieldLabel>{t("academicStructure.academicYear")}</FieldLabel>
          <select
            value={academicYear}
            onChange={(e) => setAcademicYear(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          >
            {ACADEMIC_YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </Card>

      {/* ── Terms & Sequences ── */}
      {structure.terms.map((term, termIdx) => {
        const expanded = expandedTerm === term.number;
        return (
          <Card key={term.number}>
            <button
              type="button"
              onClick={() => setExpandedTerm(expanded ? null : term.number)}
              className="flex w-full items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <Calendar className="h-5 w-5 text-indigo-500" />
                <span className="text-base font-semibold text-gray-900">
                  {t("academicStructure.term")} {term.number}: {term.name}
                </span>
              </div>
              {expanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
            </button>

            {expanded && (
              <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">

                {/* Term name & weight */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>{t("academicStructure.termName")}</FieldLabel>
                    <input
                      value={term.name}
                      onChange={(e) => updateTerm(termIdx, { name: e.target.value })}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <div>
                    <FieldLabel>{t("academicStructure.weightPct")}</FieldLabel>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        value={term.weight}
                        onChange={(e) => updateTerm(termIdx, { weight: Number(e.target.value) })}
                        className="w-24 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                      />
                      <span className="text-sm text-gray-500">%</span>
                    </div>
                  </div>
                </div>

                {/* Sequences */}
                <div className="space-y-3">
                  <FieldLabel>{t("academicStructure.sequences")}</FieldLabel>
                  {term.sequences.map((seq, seqIdx) => {
                    const isPromo = structure.promotionExams?.includes(seq.number);
                    return (
                      <div key={seq.number} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                        <div className="grid grid-cols-12 gap-3 items-end">

                          {/* Seq name */}
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-500 mb-1">
                              {SEQUENCE_NAMES[seq.number]}
                            </label>
                            <input
                              value={seq.name}
                              onChange={(e) => updateSequence(termIdx, seqIdx, { name: e.target.value })}
                              className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400"
                            />
                          </div>

                          {/* Weight */}
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-500 mb-1">
                              {t("academicStructure.weightPct")}
                            </label>
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="1"
                                value={seq.weight}
                                onChange={(e) => updateSequence(termIdx, seqIdx, { weight: Number(e.target.value) })}
                                className="w-16 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400"
                              />
                              <span className="text-xs text-gray-500">%</span>
                            </div>
                          </div>

                          {/* Assessment type */}
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-500 mb-1">
                              {t("academicStructure.assessmentType")}
                            </label>
                            <select
                              value={seq.assessment?.type ?? "test"}
                              onChange={(e) =>
                                updateSequence(termIdx, seqIdx, {
                                  assessment: { ...seq.assessment, type: e.target.value as typeof ASSESSMENT_TYPES[number] },
                                })
                              }
                              className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400"
                            >
                              {ASSESSMENT_TYPES.map((tp) => (
                                <option key={tp} value={tp}>
                                  {t(`academicStructure.type_${tp}`)}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Promotion exam toggle */}
                          <div className="col-span-2 flex items-center justify-center">
                            <button
                              type="button"
                              onClick={() => togglePromotionExam(seq.number)}
                              title={t("academicStructure.promoNotUsed")}
                              className={cn(
                                "rounded-lg px-2 py-1.5 text-xs font-medium transition",
                                isPromo
                                  ? "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300"
                                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                              )}
                            >
                              {isPromo ? t("academicStructure.promoYes") : t("academicStructure.promoNo")}
                            </button>
                          </div>

                          {/* Remove (a term keeps at least one) */}
                          <div className="col-span-1 flex items-center justify-center">
                            <button
                              type="button"
                              onClick={() => removeSequence(termIdx, seqIdx)}
                              disabled={term.sequences.length <= 1}
                              aria-label={t("academicStructure.removeSequence")}
                              title={t("academicStructure.removeSequence")}
                              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-200 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>

                        </div>
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => addSequence(termIdx)}
                      disabled={totalSequences >= MAX_SEQUENCES}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" /> {t("academicStructure.addSequence")}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTerm(termIdx)}
                      disabled={structure.terms.length <= 1}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> {t("academicStructure.removeTerm")}
                    </button>
                  </div>
                </div>

              </div>
            )}
          </Card>
        );
      })}

      {/* ── Shape of the year (docs/39 Phase 6) ── */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addTerm}
          disabled={structure.terms.length >= MAX_TERMS || totalSequences >= MAX_SEQUENCES}
          className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" /> {t("academicStructure.addTerm")}
        </button>
        <span className="text-xs text-gray-500">
          {t("academicStructure.shapeHint", { terms: MAX_TERMS, sequences: MAX_SEQUENCES })}
        </span>
      </div>

      {/* ── Global Settings ── */}
      <Card>
        <CardTitle>{t("academicStructure.globalSettings")}</CardTitle>
        <div className="space-y-4">

          {/* The annual average method and a structure-level promotion
              threshold were offered here; nothing reads them (the year's bars
              are set on Promotion → Progression), so they are no longer shown
              or sent (decided 2026-10-16, docs/41 §7). Stored values stay. */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel>{t("academicStructure.passMark")}</FieldLabel>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={20}
                  step="0.5"
                  value={structure.passMark ?? 10}
                  onChange={(e) => setStructure({ ...structure, passMark: Number(e.target.value) })}
                  className="w-24 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <span className="text-sm text-gray-500">/ 20</span>
              </div>
            </div>
          </div>

          {/* Max absences */}
          <div>
            <FieldLabel>{t("academicStructure.maxAbsences")}</FieldLabel>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={structure.maxAbsences ?? ""}
                placeholder={t("academicStructure.noLimit")}
                onChange={(e) =>
                  setStructure({ ...structure, maxAbsences: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="w-24 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>

          {/* Weight validation warning */}
          {!weightsValid && (
            <div className="flex items-center gap-2 text-amber-600 text-xs">
              <AlertCircle className="h-4 w-4" />
              {t("academicStructure.weightsMustSum", { sum: termWeightSum.toFixed(1) })}
            </div>
          )}

        </div>
      </Card>

      {/* ── Save ── */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving || !weightsValid}
          className={cn(
            "flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition",
            saving || !weightsValid
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800"
          )}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("common.save")}
        </button>
      </div>

    </div>
  );
}
