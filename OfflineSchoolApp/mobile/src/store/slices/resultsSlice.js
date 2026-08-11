// src/store/slices/resultsSlice.js
"use strict";

import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import api from "../../services/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESULTS SLICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages exam result processing and publishing state.
 *
 * Used by:
 *   app/admin/components/ResultsProcessingCard.js
 *
 * NOTE: ResultsProcessingCard has been rewritten to NOT use Redux.
 * This slice is kept for any other components that may need it,
 * but the card now uses local state + ExamService directly.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────
// THUNKS
// ─────────────────────────────────────────────────────────

/**
 * Process results for an exam.
 * POST /exams/:examId/process
 */
export const processResults = createAsyncThunk(
  "results/process",
  async (
    { examId, classId, schoolId },
    { rejectWithValue }
  ) => {
    try {
      const res = await api.post(`/exams/${examId}/process`, {
        classId,
        schoolId,
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message ||
        err.message                 ||
        "Processing failed"
      );
    }
  }
);

/**
 * Publish results for an exam.
 * PATCH /exams/:examId/status  { status: "published" }
 */
export const publishResults = createAsyncThunk(
  "results/publish",
  async (
    { examId, schoolId },
    { rejectWithValue }
  ) => {
    try {
      const res = await api.patch(`/exams/${examId}/status`, {
        status: "published",
        schoolId,
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message ||
        err.message                 ||
        "Publish failed"
      );
    }
  }
);

/**
 * Unpublish results (revert to completed).
 * PATCH /exams/:examId/status  { status: "completed" }
 */
export const unpublishResults = createAsyncThunk(
  "results/unpublish",
  async (
    { examId, schoolId },
    { rejectWithValue }
  ) => {
    try {
      const res = await api.patch(`/exams/${examId}/status`, {
        status: "completed",
        schoolId,
      });
      return res.data;
    } catch (err) {
      return rejectWithValue(
        err.response?.data?.message ||
        err.message                 ||
        "Unpublish failed"
      );
    }
  }
);

// ─────────────────────────────────────────────────────────
// INITIAL STATE
// ─────────────────────────────────────────────────────────

const initialState = {
  // Processing
  processing:     false,
  processError:   null,
  processSuccess: false,
  processData:    null,   // { processed, warnings, isPartial, stats }

  // Publishing
  publishLoading: false,
  publishError:   null,
  publishSuccess: false,

  // Unpublishing
  unpublishLoading: false,
  unpublishError:   null,
  unpublishSuccess: false,
};

// ─────────────────────────────────────────────────────────
// SLICE
// ─────────────────────────────────────────────────────────

const resultsSlice = createSlice({
  name: "results",
  initialState,

  reducers: {
    // Clear processing state (call after dismissing success/error)
    clearProcessState(state) {
      state.processing     = false;
      state.processError   = null;
      state.processSuccess = false;
      state.processData    = null;
    },

    // Clear publish state
    clearPublishState(state) {
      state.publishLoading = false;
      state.publishError   = null;
      state.publishSuccess = false;
    },

    // Reset everything
    resetResultsState() {
      return initialState;
    },
  },

  extraReducers: (builder) => {

    // ── processResults ──────────────────────────────────────────────────
    builder
      .addCase(processResults.pending, (state) => {
        state.processing     = true;
        state.processError   = null;
        state.processSuccess = false;
        state.processData    = null;
      })
      .addCase(processResults.fulfilled, (state, action) => {
        state.processing     = false;
        state.processSuccess = true;
        state.processData    = action.payload;
      })
      .addCase(processResults.rejected, (state, action) => {
        state.processing   = false;
        state.processError = action.payload;
      });

    // ── publishResults ──────────────────────────────────────────────────
    builder
      .addCase(publishResults.pending, (state) => {
        state.publishLoading = true;
        state.publishError   = null;
        state.publishSuccess = false;
      })
      .addCase(publishResults.fulfilled, (state) => {
        state.publishLoading = false;
        state.publishSuccess = true;
      })
      .addCase(publishResults.rejected, (state, action) => {
        state.publishLoading = false;
        state.publishError   = action.payload;
      });

    // ── unpublishResults ────────────────────────────────────────────────
    builder
      .addCase(unpublishResults.pending, (state) => {
        state.unpublishLoading = true;
        state.unpublishError   = null;
        state.unpublishSuccess = false;
      })
      .addCase(unpublishResults.fulfilled, (state) => {
        state.unpublishLoading = false;
        state.unpublishSuccess = true;
      })
      .addCase(unpublishResults.rejected, (state, action) => {
        state.unpublishLoading = false;
        state.unpublishError   = action.payload;
      });
  },
});

// ─────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────

export const {
  clearProcessState,
  clearPublishState,
  resetResultsState,
} = resultsSlice.actions;

export default resultsSlice.reducer;