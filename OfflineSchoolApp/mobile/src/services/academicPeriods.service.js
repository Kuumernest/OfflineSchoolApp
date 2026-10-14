// mobile/src/services/academicPeriods.service.js
//
// The year's terms as the school defined them (docs/39 Phase 6) — what the
// exam screens offer in their term picker, in place of a fixed 1st/2nd/3rd.
//
// GET /api/academic-structure/:schoolId/:year. An administrator reads it with
// settings.view, a teacher with exams.view (docs/39 D4); either way the answer
// carries the terms. The last answer per school and year is kept, so the
// picker still shows the school's own terms with no connection.
//
// null when neither the server nor the cache can say — the caller then offers
// the fixed three terms, exactly as before. Never throws.

import AsyncStorage from "@react-native-async-storage/async-storage";
import api          from "./api";

const cacheKey = (schoolId, academicYear) => `academicTerms:${schoolId}:${academicYear}`;

/**
 * The structure's terms as [{ number, name }], in number order; null if the
 * structure has none. Exam.term is a number 1–3, so anything else is dropped.
 */
export const termsOfStructure = (structure) => {
  const terms = Array.isArray(structure?.terms) ? structure.terms : [];
  const out = terms
    .map((term) => ({ number: Number(term?.number), name: typeof term?.name === "string" ? term.name.trim() : "" }))
    .filter((term) => Number.isInteger(term.number) && term.number >= 1 && term.number <= 3)
    .sort((a, b) => a.number - b.number);
  return out.length ? out : null;
};

export const fetchAcademicTerms = async (schoolId, academicYear) => {
  if (!schoolId || !academicYear) return null;
  const key = cacheKey(schoolId, academicYear);

  try {
    const res   = await api.get(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`);
    const terms = termsOfStructure(res.data?.structure);
    if (terms) await AsyncStorage.setItem(key, JSON.stringify(terms)).catch(() => {});
    return terms;
  } catch {
    // Offline, or refused: the last answer for this year, if there was one.
  }

  try {
    const cached = await AsyncStorage.getItem(key);
    return cached ? termsOfStructure({ terms: JSON.parse(cached) }) : null;
  } catch {
    return null;
  }
};
