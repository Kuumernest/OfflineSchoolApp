// web/src/services/academicRules.service.ts
//
// How results are calculated, and a school's promotion bars for one year
// (backend: routes/academicStructure.routes.js, shared/academicRules.js).
//
// The calculation is the same for every school, decided by the project owner
// (docs/39 §21.1): the server reports it and refuses any write to it. What a
// school sets is its promotion bars: one for classes without their own (null
// = the pass mark) and one per class, all out of 20.

import api from "@/services/api";

/** The decided behaviour, as the server reports it. Not editable. */
export interface PlatformRules {
  sequenceAverage:  "weighted_20";
  gradingAuthority: "school_bands";
  promotionRule:    "annual_average_at_least";
  publishedResults: "refuse";
}

export interface AcademicRules extends Omit<PlatformRules, "promotionRule"> {
  /** "manual_only" only where it was stored before the decision. */
  promotionRule:      "annual_average_at_least" | "manual_only";
  /** The school's bar on /20; null = the pass mark. */
  promotionThreshold: number | null;
  /** A class's own bar, by classId, on /20. */
  classThresholds:    Record<string, number>;
}

export interface Bars {
  promotionThreshold: number | null;
  classThresholds:    Record<string, number>;
  /** What a class without its own bar is judged against. */
  defaultBar:         number;
  defaultBarSource:   "school" | "passMark";
  passMark:           number;
}

export interface ResultCounts { published: number; unpublished: number }

export interface RulesImpact {
  sequence: ResultCounts;
  term:     ResultCounts;
  annual:   ResultCounts;
  draftPromotionRuns: number;
}

export interface RulesState {
  academicYear: string;
  rules:        AcademicRules;
  bars:         Bars;
  platform:     PlatformRules;
  impact:       RulesImpact;
}

/** A bar write: a class bar of null removes that class's own bar. */
export interface BarsWrite {
  promotionThreshold?: number | null;
  classThresholds?:    Record<string, number | null>;
}

const base = (schoolId: string, year: string) =>
  `/academic-structure/${encodeURIComponent(schoolId)}/${encodeURIComponent(year)}/rules`;

export async function fetchRules(schoolId: string, year: string): Promise<RulesState> {
  const { data } = await api.get(base(schoolId, year));
  return data as RulesState;
}

/** Validated, refused while a draft promotion run exists, audited with the reason. */
export async function saveBars(
  schoolId: string, year: string, bars: BarsWrite, reason: string
): Promise<{ changed: boolean; rules: AcademicRules }> {
  const { data } = await api.put(base(schoolId, year), { rules: bars, reason });
  return { changed: Boolean(data?.changed), rules: data?.rules as AcademicRules };
}
