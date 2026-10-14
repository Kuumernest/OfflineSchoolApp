// web/src/services/academicRules.service.ts
//
// A school's calculation rules for one academic year (docs/39 Phase 4–5;
// backend: routes/academicStructure.routes.js, shared/academicRules.js).
//
// Every rule is a decision that changes real results, and every default is
// how results were computed before rules existed. The server sends the rule
// definitions (values, defaults, which decision each answers), so this file
// carries no second copy of them — only the shapes.

import api from "@/services/api";

export type SequenceAverageRule  = "raw_mean" | "weighted_20";
export type GradingAuthorityRule = "split" | "school_bands";
export type PromotionRule =
  | "legacy" | "annual_average_at_least" | "majority_of_terms_passed" | "manual_only";
export type PublishedResultsRule = "overwrite" | "refuse";

export interface AcademicRules {
  sequenceAverage:    SequenceAverageRule;
  gradingAuthority:   GradingAuthorityRule;
  promotionRule:      PromotionRule;
  publishedResults:   PublishedResultsRule;
  /** On /20; required by annual_average_at_least. */
  promotionThreshold: number | null;
  /** A class's own bar, by classId, overriding promotionThreshold. */
  classThresholds:    Record<string, number>;
}

export type RuleKey = "sequenceAverage" | "gradingAuthority" | "promotionRule" | "publishedResults";
export const RULE_KEYS: RuleKey[] = ["sequenceAverage", "gradingAuthority", "promotionRule", "publishedResults"];

export interface RuleDefinition {
  decision: string;
  default:  string;
  values:   string[];
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
  isDefault:    boolean;
  defaults:     AcademicRules;
  definitions:  Record<RuleKey, RuleDefinition>;
  impact:       RulesImpact;
}

export interface RuleChange {
  rule:    keyof AcademicRules;
  from:    unknown;
  to:      unknown;
  /** Which results the change reaches: sequence, term, annual, promotion. */
  affects: string[];
}

export interface RulesPreview {
  changes: RuleChange[];
  rules:   AcademicRules;
  impact:  RulesImpact;
}

const base = (schoolId: string, year: string) =>
  `/academic-structure/${encodeURIComponent(schoolId)}/${encodeURIComponent(year)}/rules`;

export async function fetchRules(schoolId: string, year: string): Promise<RulesState> {
  const { data } = await api.get(base(schoolId, year));
  return data as RulesState;
}

export async function previewRules(
  schoolId: string, year: string, rules: Partial<AcademicRules>
): Promise<RulesPreview> {
  const { data } = await api.post(`${base(schoolId, year)}/preview`, { rules });
  return data as RulesPreview;
}

export async function saveRules(
  schoolId: string, year: string, rules: Partial<AcademicRules>, reason: string | null
): Promise<{ changed: boolean; rules: AcademicRules }> {
  const { data } = await api.put(base(schoolId, year), { rules, reason });
  return { changed: Boolean(data?.changed), rules: data?.rules as AcademicRules };
}
