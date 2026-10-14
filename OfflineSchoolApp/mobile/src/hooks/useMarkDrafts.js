// mobile/src/hooks/useMarkDrafts.js

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The marks a teacher is typing, kept apart from the marks the screen holds.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 *
 * Every mark box on the two entry screens was a controlled TextInput whose
 * value came straight out of one `scores` object in an 1,800-line screen
 * component. One keystroke therefore re-rendered the whole screen, the
 * FlatList and every visible row (an inline renderItem, no memo boundary),
 * recounted the entered marks, re-armed the 30-second draft timer and — on the
 * first keystroke — gave the box a `borderWidth: 1.5` and a "%" badge the
 * moment it held a digit.
 *
 * That last part is the mechanism behind "I typed 16 and got 6". With
 * `selectTextOnFocus`, Android's ReactEditText selects ALL of its text on the
 * first layout pass that happens while it is focused (ReactEditText.kt,
 * onLayout). The first digit changed the box's frame, that layout pass
 * selected the digit, and the second digit replaced the selection. The heavy
 * re-render only decided WHEN that layout landed relative to the next key,
 * which is why typing speed seemed to matter.
 *
 * ── The arrangement now ─────────────────────────────────────────────────────
 *
 *   keystroke  → MarkInputRow's own draft state → on screen at once
 *              → draftChanged(): a ref write here and a commit in 200 ms
 *   commit     → `scores` updated once, for everything typed since the last
 *   flush()    → the same, now: on blur, on "next", on save, on leaving
 *
 * `scores` is still the one place the save, the draft autosave and the
 * progress header read from; it is simply no longer written per keystroke.
 * Anything about to save calls flush() first and uses what it returns.
 *
 * `generation` counts wholesale replacements of `scores` — a load, a restored
 * draft. A row adopts the committed value only when that, or its own
 * `isAbsent`, changes. It never adopts a plain change to its score, because
 * that is normally its own typing arriving back 200 ms later, and the teacher
 * may have typed more by then.
 */

export const COMMIT_DELAY_MS = 200;

const withScore = (prev, sid, score) => ({ ...prev, [sid]: { ...prev[sid], score } });

const merge = (base, pending) => {
  let next = base;
  for (const sid of Object.keys(pending)) next = withScore(next, sid, pending[sid]);
  return next;
};

export function useMarkDrafts({ onDirty } = {}) {
  const [scores, setScores]         = useState({});
  const [generation, setGeneration] = useState(0);

  // sid → text typed but not yet in `scores`.
  const pendingRef = useRef({});
  const timerRef   = useRef(null);
  const scoresRef  = useRef(scores);
  const onDirtyRef = useRef(onDirty);

  useEffect(() => { scoresRef.current  = scores;  }, [scores]);
  useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);

  /**
   * Commit everything pending, now. Returns the marks as they stand with the
   * pending ones folded in, so a save can use the result without waiting for
   * the state update to render.
   */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending  = pendingRef.current;
    const snapshot = merge(scoresRef.current, pending);
    if (Object.keys(pending).length) {
      pendingRef.current = {};
      setScores((prev) => merge(prev, pending));
    }
    return snapshot;
  }, []);

  /** A keystroke. Nothing here renders; the row has already shown the text. */
  const draftChanged = useCallback((sid, text) => {
    pendingRef.current[sid] = text;
    onDirtyRef.current?.();
    if (!timerRef.current) timerRef.current = setTimeout(flush, COMMIT_DELAY_MS);
  }, [flush]);

  /** What a row typed that has not been committed yet, if anything. */
  const readPending = useCallback((sid) => pendingRef.current[sid], []);

  /** Replace the whole sheet — a load, a restored draft. Rows adopt it. */
  const replaceScores = useCallback((map) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = {};
    setScores(map ?? {});
    setGeneration((g) => g + 1);
  }, []);

  const toggleAbsent = useCallback((sid) => {
    // Marking a child absent clears their mark, including one still on its
    // way here from the row.
    delete pendingRef.current[sid];
    onDirtyRef.current?.();
    setScores((prev) => {
      const was = prev[sid]?.isAbsent ?? false;
      return {
        ...prev,
        [sid]: {
          ...prev[sid],
          isAbsent: !was,
          score:    !was ? "" : prev[sid]?.score ?? "",
        },
      };
    });
  }, []);

  const markAllPresent = useCallback((students) => {
    onDirtyRef.current?.();
    setScores((prev) => {
      const updated = {};
      for (const s of students) {
        updated[s._id] = { ...(prev[s._id] || {}), isAbsent: false };
      }
      return { ...prev, ...updated };
    });
  }, []);

  // A timer left running would commit into a screen that has gone.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return {
    scores, generation,
    draftChanged, flush, readPending,
    replaceScores, toggleAbsent, markAllPresent,
  };
}

export default useMarkDrafts;
