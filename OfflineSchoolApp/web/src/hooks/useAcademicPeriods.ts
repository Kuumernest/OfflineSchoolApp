// web/src/hooks/useAcademicPeriods.ts
//
// The year's terms and sequences as the school defined them (docs/39 Phase 6),
// for every screen that offers a term or a sequence to pick or prints one as a
// column.
//
// Those screens used fixed constants — three terms, sequences 1–2 / 3–4 / 5–6,
// sequences 5 and 6 as the promotion exams — so a school whose year is shaped
// differently (two semesters of three evaluations, say) was offered the wrong
// periods. This reads the year's AcademicStructure instead.
//
// It falls back to those constants, unchanged, whenever the structure cannot
// be read: no school, no year, a role without settings.view (teachers today —
// docs/39 §4.6j), or no connection. So a screen that used to work keeps
// working exactly as before; it only becomes correct for schools that differ.

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import api from "@/services/api";
import { useUser } from "@/store/auth.store";
import { SEQUENCE_MAP, TERM_OPTIONS } from "@/constants/exam.constants";
import type { SequenceNumber } from "@/types/exam.types";

export interface PeriodSequence {
  number: number;
  label:  string;
  /** A promotion exam of the year (AcademicStructure.promotionExams). */
  isPromotion: boolean;
}

export interface PeriodTerm {
  number:    number;
  label:     string;
  sequences: PeriodSequence[];
}

export interface AcademicPeriods {
  terms: PeriodTerm[];
  /** True when the terms came from the school's structure, not the constants. */
  fromStructure: boolean;
  sequencesOf: (term: number | string) => PeriodSequence[];
  termLabel:   (term: number | string) => string;
}

interface RawStructure {
  terms?: Array<{ number: number; name?: string | null; sequences?: Array<{ number: number; name?: string | null }> }>;
  promotionExams?: number[];
}

const FALLBACK_PROMOTION = [5, 6];

export function useAcademicPeriods(academicYear: string | undefined | null): AcademicPeriods {
  const { t } = useTranslation();
  const schoolId = useUser()?.schoolId ?? null;

  const query = useQuery({
    queryKey: ["academicPeriods", schoolId, academicYear],
    queryFn: async () => {
      const { data } = await api.get(
        `/academic-structure/${encodeURIComponent(String(schoolId))}/${encodeURIComponent(String(academicYear))}`
      );
      return (data?.structure ?? null) as RawStructure | null;
    },
    enabled: Boolean(schoolId && academicYear),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const seqLabel = (n: number, name?: string | null) =>
    name || (SEQUENCE_MAP[n as SequenceNumber] ? t(SEQUENCE_MAP[n as SequenceNumber].labelKey) : t("academicPeriods.sequenceN", { n }));
  const termFallbackLabel = (n: number) => {
    const opt = TERM_OPTIONS.find((o) => o.value === String(n));
    return opt ? t(opt.labelKey) : t("academicPeriods.termN", { n });
  };

  const structure = query.data;
  const fromStructure = Boolean(structure?.terms?.length);

  let terms: PeriodTerm[];
  if (fromStructure) {
    const promo = new Set((structure!.promotionExams ?? []).map(Number));
    terms = [...structure!.terms!]
      .sort((a, b) => a.number - b.number)
      .map((tm) => ({
        number: tm.number,
        label:  tm.name || termFallbackLabel(tm.number),
        sequences: [...(tm.sequences ?? [])]
          .sort((a, b) => a.number - b.number)
          .map((s) => ({ number: s.number, label: seqLabel(s.number, s.name), isPromotion: promo.has(s.number) })),
      }));
  } else {
    terms = TERM_OPTIONS.map((o) => {
      const n = Number(o.value);
      return {
        number: n,
        label:  t(o.labelKey),
        sequences: (Object.keys(SEQUENCE_MAP) as unknown as SequenceNumber[])
          .map(Number)
          .filter((s) => SEQUENCE_MAP[s as SequenceNumber].term === n)
          .map((s) => ({ number: s, label: seqLabel(s), isPromotion: FALLBACK_PROMOTION.includes(s) })),
      };
    });
  }

  return {
    terms,
    fromStructure,
    sequencesOf: (term) => terms.find((tm) => tm.number === Number(term))?.sequences ?? [],
    termLabel:   (term) => terms.find((tm) => tm.number === Number(term))?.label ?? termFallbackLabel(Number(term)),
  };
}
