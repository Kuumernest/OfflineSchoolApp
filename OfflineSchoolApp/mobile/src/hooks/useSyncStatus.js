// src/hooks/useSyncStatus.js
"use strict";

/**
 * One place to ask "are we online, and is anything waiting to upload?".
 *
 * Before this, connectivity was re-derived ad hoc in a handful of screens
 * and the outbox was invisible everywhere — a teacher could take a register
 * offline and get no signal at all that it had not left the device.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { MutationQueue } from "../services/mutationQueue.service";
import { SyncManager } from "../services/syncManager";
import * as SyncProgress from "../services/syncProgress";
import { useAuthStore } from "../store/auth.store";
import { offlineAge } from "../config/offlinePeriod";

const POLL_MS = 15_000;

const EMPTY = { pending: 0, retrying: 0, conflict: 0, failed: 0, uploads: 0, unsent: 0 };

export const useSyncStatus = ({ poll = true } = {}) => {
  const [isConnected, setIsConnected] = useState(true);
  const [stats, setStats] = useState(EMPTY);
  // The server time of the last successful pull (SyncManager's cursor, read
  // only). Drives the 21/30-day notice in config/offlinePeriod.js.
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const token = useAuthStore((s) => s.token);
  const mounted = useRef(true);

  const isOfflineSession = token === "offline_mode";

  const refresh = useCallback(async () => {
    try {
      const next = await MutationQueue.getStats();
      if (mounted.current) setStats(next);
    } catch {
      /* the table may not exist yet on a cold start — not worth surfacing */
    }
    try {
      const last = await SyncManager.getLastSync();
      if (mounted.current) setLastSyncedAt(last || null);
    } catch {
      /* no stored time reads as "unknown", which shows nothing */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Connectivity
  useEffect(() => {
    let cancelled = false;
    NetInfo.fetch().then((s) => {
      if (!cancelled) setIsConnected(s.isConnected !== false);
    }).catch(() => {});

    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsConnected(state.isConnected !== false);
      if (state.isConnected) refresh();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [refresh]);

  // Outbox depth
  useEffect(() => {
    refresh();
    if (!poll) return undefined;

    const interval = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => { clearInterval(interval); sub.remove(); };
  }, [poll, refresh]);

  // A sync that just finished may have moved the last-sync time: re-read it
  // when a run ends rather than waiting for the next poll.
  useEffect(() => {
    let wasActive = false;
    return SyncProgress.subscribe((s) => {
      if (wasActive && !s.active) refresh();
      wasActive = Boolean(s.active);
    });
  }, [refresh]);

  return {
    isConnected,
    isOfflineSession,
    stats,
    pendingCount: stats.unsent,
    hasBlocked: stats.conflict > 0 || stats.failed > 0,
    lastSyncedAt,
    // { level: "none" | "notice" (day 21+) | "warning" (day 30+), days }
    offlineAge: offlineAge(lastSyncedAt),
    refresh,
  };
};

export default useSyncStatus;
