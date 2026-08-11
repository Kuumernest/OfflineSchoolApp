// src/store/results.store.js
import { create } from "zustand";
import { examAPI } from "../services/api";

export const useResultsStore = create((set) => ({
  rankings: [],
  stats:    null,
  loading:  false,

  fetchResults: async (examId) => {
    set({ loading: true });
    try {
      const data = await examAPI.getResults(examId);
      set({ rankings: data.rankings, stats: data.stats });
    } catch (e) {
      console.error("fetchResults failed:", e);
    } finally {
      set({ loading: false });
    }
  },
}));