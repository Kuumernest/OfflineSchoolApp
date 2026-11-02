// web/src/lib/offline/connectivityWatch.ts
//
// Feeds lib/offline/connectivity.ts from the world, and reads it into React.
//
// Three sources, all reporting into the same state machine:
//
//   the window's online/offline events   the device's own opinion
//   lib/axios.ts                          every response, and every request that
//                                         got none (wired there, not here)
//   the desktop's sync engine             on the desktop, whether the last cycle
//                                         reached the server — the best evidence
//                                         available, since most of its reads and
//                                         writes never touch the network

import { useSyncExternalStore } from "react";
import { connectivity, type ConnectivityState } from "./connectivity";
import { desktop, type SyncStatus } from "./bridge";

let started = false;

const fromSync = (status: SyncStatus | null | undefined) => {
  if (!status) return;
  if (status.phase === "offline") connectivity.deviceOffline();
  // Each of these is only reached after the server answered.
  else if (status.phase === "idle" || status.phase === "blocked" || status.phase === "pulling") {
    connectivity.reached();
  }
};

/** Start listening. Once, at bootstrap (main.tsx); repeat calls do nothing. */
export const startConnectivityWatch = (): void => {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("offline", () => connectivity.deviceOffline());
  window.addEventListener("online",  () => connectivity.deviceOnline());

  const bridge = desktop();
  if (bridge) {
    void bridge.sync.status().then(fromSync).catch(() => { /* the indicator reports its own failures */ });
    bridge.sync.onStatus(fromSync);
  }
};

/** The current connectivity, re-rendering when it changes. */
export const useConnectivity = (): ConnectivityState =>
  useSyncExternalStore(connectivity.subscribe, connectivity.get, connectivity.get);

/** Shorthand for the one question most callers have. */
export const useIsOffline = (): boolean => useConnectivity().offline;
