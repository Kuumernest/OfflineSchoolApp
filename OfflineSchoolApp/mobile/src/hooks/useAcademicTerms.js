// mobile/src/hooks/useAcademicTerms.js
//
// Term picker options for one school year: the school's own terms when the
// year's structure can be read (or was read before), the fixed three
// otherwise. Values are the term number as a string, for the pickers; send
// Number(value), because Exam.term is a number.

import { useEffect, useMemo, useState } from "react";

import { fetchAcademicTerms } from "../services/academicPeriods.service";

const FALLBACK = [1, 2, 3].map((number) => ({ number, name: "" }));

/**
 * @param {string|null} schoolId
 * @param {string|null} academicYear  "2026/2027"
 * @param {(number: number) => string} fallbackLabel  label for a term with no name;
 *        keep it stable (useCallback), since the options are memoised on it
 * @returns {{ options: Array<{value: string, label: string}>, fromStructure: boolean }}
 */
export const useAcademicTerms = (schoolId, academicYear, fallbackLabel) => {
  const [terms, setTerms] = useState(null);

  useEffect(() => {
    let live = true;
    setTerms(null);
    fetchAcademicTerms(schoolId, academicYear).then((found) => { if (live) setTerms(found); });
    return () => { live = false; };
  }, [schoolId, academicYear]);

  const options = useMemo(() => (terms ?? FALLBACK).map((term) => ({
    value: String(term.number),
    label: term.name || fallbackLabel(term.number),
  })), [terms, fallbackLabel]);

  return { options, fromStructure: Boolean(terms) };
};
