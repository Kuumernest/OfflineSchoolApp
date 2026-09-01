// web/src/pages/settings/AcademicStructureSection.tsx
import { useState, useEffect, useCallback } from "react";
import {
  Calendar, Save, Loader2, AlertCircle, Plus, Trash2, ChevronDown, ChevronUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
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

const extractMessage = (err: unknown): string =>
  (err as { response?: { data?: { message?: string } } })
    ?.response?.data?.message ??
  (err instanceof Error ? err.message : "Something went wrong");

/** Ensure a structure matches current schema defaults (migration-safe). */
function normalise(raw: AcademicStructure): AcademicStructure {
  const terms = (raw.terms ?? DEFAULT_TERMS).map((t, i) => {
    const num = (i + 1) as TermNumber;
    return {
      ...t,
      number: num,
      sequences: (t.sequences ?? []).map((s, j) => {
        const seqNum = ((num - 1) * 2 + j + 1) as SequenceNumber;
        return {
          ...s,
          number: seqNum,
          weight: s.weight ?? 50,
          assessment: s.assessment ?? { type: "test" as const },
        };
      }),
    };
  });
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

  useEffect(() => { load(); }, [load]);

  // ── Save ──
  const handleSave = async () => {
    if (!structure) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`, {
        terms: structure.terms,
        annualAverageMethod: structure.annualAverageMethod,
        promotionExams: structure.promotionExams,
        promotionThreshold: structure.promotionThreshold,
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
                          <div className="col-span-4">
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

                        </div>
                      </div>
                    );
                  })}
                </div>

              </div>
            )}
          </Card>
        );
      })}

      {/* ── Global Settings ── */}
      <Card>
        <CardTitle>{t("academicStructure.globalSettings")}</CardTitle>
        <div className="space-y-4">

          {/* Annual average method */}
          <div>
            <FieldLabel>{t("academicStructure.annualAvgMethod")}</FieldLabel>
            <div className="flex gap-3 mt-1">
              {(["terms", "sequences"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setStructure({ ...structure, annualAverageMethod: m })}
                  className={cn(
                    "rounded-xl px-4 py-2 text-sm font-medium transition border",
                    structure.annualAverageMethod === m
                      ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                      : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                  )}
                >
                  {t(`academicStructure.method_${m}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Promotion threshold */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel>{t("academicStructure.promotionThreshold")}</FieldLabel>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={20}
                  step="0.5"
                  value={structure.promotionThreshold ?? 10}
                  onChange={(e) => setStructure({ ...structure, promotionThreshold: Number(e.target.value) })}
                  className="w-24 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <span className="text-sm text-gray-500">/ 20</span>
              </div>
            </div>
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
