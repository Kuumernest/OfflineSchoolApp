// src/hooks/useSyncProgress.js
"use strict";

/**
 * Subscribe to the running sync's progress.
 *
 * A companion to useSyncStatus, which answers "is anything waiting?". This
 * one answers the question a person actually asks while watching the strip at
 * the bottom of the screen: how far along is it, and what is it doing now.
 *
 * Returns { active, visible, percent, done, total, label, detail } where
 * `label` is already translated and `percent` is 0..100. `visible` is false
 * for the background tick — see syncProgress.begin.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "../i18n/useTranslation";
import * as SyncProgress from "../services/syncProgress";

export const useSyncProgress = () => {
  const { t } = useTranslation();
  const [state, setState] = useState(() => SyncProgress.getState());

  useEffect(() => SyncProgress.subscribe(setState), []);

  const total = state.steps?.length ?? 0;

  return {
    active:  Boolean(state.active),
    visible: Boolean(state.active && state.visible),

    // Rounded once, here, so every consumer shows the same number.
    percent: Math.round(SyncProgress.fractionOf(state) * 100),

    // The step tally, for a caller that would rather show "7 / 13" than a
    // percentage. Reported as steps, which is what they are — the inner item
    // count is folded into `percent` and surfaced through `detail`.
    done:  state.index ?? 0,
    total,

    label: state.stepKey ? t(SyncProgress.SYNC_STEPS[state.stepKey]) : "",

    // Rows for a collection step, "3 / 14" for the outbox drain, "" when the
    // step has nothing more specific to say.
    detail: state.itemTotal > 0
      ? `${state.itemDone} / ${state.itemTotal}`
      : (state.detail || ""),
  };
};

export default useSyncProgress;
