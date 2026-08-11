// src/hooks/useUploadQueue.js
"use strict";

import { useEffect, useRef, useCallback } from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import {
  processPendingUploads,
  getUploadQueueStats,
} from "../services/content.service";

/**
 * Drop this hook in your root layout or teacher dashboard.
 * It automatically processes queued uploads when:
 *   1. App comes back online
 *   2. App returns to foreground
 */
export const useUploadQueue = ({
  onSuccess,
  onError,
  onComplete,
} = {}) => {
  const isProcessing = useRef(false);

  const process = useCallback(async () => {
    if (isProcessing.current) return;
    isProcessing.current = true;

    try {
      await processPendingUploads({
        onItemSuccess: (result) => {
          console.log(`✅ Queued upload synced: ${result.queueId}`);
          onSuccess?.(result);
        },
        onItemError: (result) => {
          console.warn(`❌ Queued upload failed: ${result.queueId} — ${result.error}`);
          onError?.(result);
        },
        onComplete: (summary) => {
          if (summary.succeeded > 0 || summary.failed > 0) {
            onComplete?.(summary);
          }
        },
      });
    } finally {
      isProcessing.current = false;
    }
  }, [onSuccess, onError, onComplete]);

  // ── Process when network comes back online ────────────────────────────────
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        // Small delay to let the connection stabilise
        setTimeout(process, 2000);
      }
    });
    return () => unsubscribe();
  }, [process]);

  // ── Process when app comes to foreground ──────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        process();
      }
    });
    return () => sub.remove();
  }, [process]);

  // ── Process on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    process();
  }, [process]);

  return { processNow: process };
};