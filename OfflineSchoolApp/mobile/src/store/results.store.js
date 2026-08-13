// src/store/results.store.js
"use strict";

import { create }      from "zustand";
import { ExamService } from "../services/exam.service";

export const useResultsStore = create((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────────
  results:  [],          // flat ResultSummary[] from the server
  rankings: {            // ✅ FIX: object with per-scope arrays, not a flat array.
    class:  [],          //    The screen reads rankings.class / .grade / .school
    grade:  [],          //    but the old store stored rankings as a flat array
    school: [],          //    which made all three tabs render nothing.
  },
  stats:    null,
  loading:  false,
  error:    null,

  // ── fetchResults ────────────────────────────────────────────────────────────
  // Fetches the full result list + stats for one exam, then builds
  // per-scope ranking lists from the result data.
  fetchResults: async (examId, { schoolId, classId } = {}) => {
    if (!examId) {
      console.warn("[results.store] fetchResults: examId is required");
      return;
    }

    set({ loading: true, error: null });

    try {
      const [resultsRes, statsRes] = await Promise.allSettled([
        ExamService.getResults({ examId, schoolId, classId }),
        ExamService.getExamStats(examId, schoolId),
      ]);

      // ── Results ───────────────────────────────────────────────────────────
      const results = resultsRes.status === "fulfilled"
        ? (resultsRes.value?.results ?? [])
        : [];

      if (resultsRes.status === "rejected") {
        console.warn(
          "[results.store] getResults failed:",
          resultsRes.reason?.message
        );
      }

      // ── Stats ─────────────────────────────────────────────────────────────
      const stats = statsRes.status === "fulfilled"
        ? (statsRes.value ?? null)
        : null;

      if (statsRes.status === "rejected") {
        console.warn(
          "[results.store] getExamStats failed:",
          statsRes.reason?.message
        );
      }

      // ── Build per-scope ranking lists ─────────────────────────────────────
      // ✅ FIX: the screen accesses rankings.class, rankings.grade,
      //    rankings.school. We derive all three from the flat results
      //    array returned by the server. Each student has classPosition,
      //    gradePosition, schoolPosition fields.
      const byClass = [...results].sort(
        (a, b) => (a.classPosition ?? 9999) - (b.classPosition ?? 9999)
      );
      const byGrade = [...results].sort(
        (a, b) => (a.gradePosition ?? 9999) - (b.gradePosition ?? 9999)
      );
      const bySchool = [...results].sort(
        (a, b) => (a.schoolPosition ?? 9999) - (b.schoolPosition ?? 9999)
      );

      // ✅ Single atomic set — loading:false in same render as data
      set({
        results,
        rankings: {
          class:  byClass,
          grade:  byGrade,
          school: bySchool,
        },
        stats,
        loading: false,
        error:   null,
      });

    } catch (e) {
      console.error("[results.store] fetchResults failed:", e.message);
      set({ error: e.message, loading: false });
    }
    // ✅ No finally block — every code path sets loading:false above
  },

  // ── fetchRankings ───────────────────────────────────────────────────────────
  // Fetches a single scope's rankings from the dedicated rankings endpoint.
  // Useful for refreshing one tab without reloading everything.
  fetchRankings: async (
    examId,
    { schoolId, scope = "class", classId } = {}
  ) => {
    if (!examId) return;

    set({ loading: true, error: null });

    try {
      const data = await ExamService.getRankings(
        examId, schoolId, scope, classId
      );
      const list = data?.rankings ?? data?.data ?? data ?? [];
      const arr  = Array.isArray(list) ? list : [];

      // ✅ Merge into the correct scope key without wiping other scopes
      set((state) => ({
        rankings: {
          ...state.rankings,
          [scope]: arr,
        },
        loading: false,
      }));
    } catch (e) {
      console.error("[results.store] fetchRankings failed:", e.message);
      set({ error: e.message, loading: false });
    }
  },

  // ── fetchStats ──────────────────────────────────────────────────────────────
  fetchStats: async (examId, schoolId) => {
    if (!examId) return;
    set({ loading: true, error: null });
    try {
      const stats = await ExamService.getExamStats(examId, schoolId);
      set({ stats, loading: false });
    } catch (e) {
      console.error("[results.store] fetchStats failed:", e.message);
      set({ error: e.message, loading: false });
    }
  },

  // ── clearResults ────────────────────────────────────────────────────────────
  // ✅ FIX: was missing entirely — caused "undefined is not a function"
  //    when the screen's useEffect cleanup tried to call it on unmount.
  clearResults: () =>
    set({
      results:  [],
      rankings: { class: [], grade: [], school: [] },
      stats:    null,
      error:    null,
      loading:  false,
    }),
}));