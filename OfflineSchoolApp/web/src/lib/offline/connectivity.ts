// web/src/lib/offline/connectivity.ts
//
// Is the server reachable from here — the one answer the offline banner and the
// "needs internet" notices are drawn from.
//
// ── Why two kinds of evidence ─────────────────────────────────────────────
//
// navigator.onLine and the window's online/offline events only know whether
// the machine has a link. A school on a router whose uplink is down, or a
// laptop on a hotspot with no credit, reports "online" all day while every
// request fails. So a request that got no response at all (axios ERR_NETWORK)
// counts as evidence too, and any response from the server — of any status —
// counts as evidence of the opposite.
//
// A timeout does not count either way: it is a slow link, not a missing one,
// and lib/linkQuality.ts already adapts to it.
//
// ── Why it imports nothing ────────────────────────────────────────────────
//
// The rules below are the part with mistakes to make, so they are a plain state
// machine that scripts/check-connectivity.mjs runs from Node. The wiring — window
// events, the desktop's sync status, React — lives in connectivityWatch.ts.

/** Why the app believes it is offline. */
export type OfflineReason =
  /** The device reports no network (or, on the desktop, sync could not reach the server). */
  | "device"
  /** The device reports a network, but a request got no response. */
  | "request";

export interface ConnectivityState {
  offline: boolean;
  reason:  OfflineReason | null;
}

export interface Connectivity {
  /** The current state. The same object until something changes (useSyncExternalStore relies on it). */
  get(): ConnectivityState;
  subscribe(listener: () => void): () => void;
  /** window "offline", or navigator.onLine false at start. */
  deviceOffline(): void;
  /** window "online". */
  deviceOnline(): void;
  /** A request that got no response at all. */
  unreachable(): void;
  /** Any response from the server, whatever its status. */
  reached(): void;
}

const ONLINE: ConnectivityState = Object.freeze({ offline: false, reason: null });

export const createConnectivity = (startOnline = true): Connectivity => {
  let state: ConnectivityState = startOnline ? ONLINE : Object.freeze({ offline: true, reason: "device" });
  const listeners = new Set<() => void>();

  const setState = (next: ConnectivityState) => {
    if (next.offline === state.offline && next.reason === state.reason) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    deviceOffline: () => setState(Object.freeze({ offline: true, reason: "device" })),
    // The device says it is back. Believed: if the link is up but the internet
    // is not, the next request that fails says so again.
    deviceOnline: () => setState(ONLINE),
    // Offline already for a stronger reason (the device itself) stays so.
    unreachable: () => {
      if (!state.offline) setState(Object.freeze({ offline: true, reason: "request" }));
    },
    // The server answered, so it is reachable — even if the device still
    // claims otherwise (navigator.onLine is known to be wrong on some links).
    reached: () => setState(ONLINE),
  };
};

/**
 * Did this request fail for want of a network?
 *
 * axios's ERR_NETWORK with no response: offline, DNS, a refused connection, or
 * on the desktop a forward the main process could not complete
 * (appProtocol.js answers Response.error() for exactly that). Not a timeout and
 * not a cancellation.
 */
export const isNoNetworkError = (err: unknown): boolean => {
  const e = err as { code?: string; response?: unknown } | null;
  return !!e && e.code === "ERR_NETWORK" && !e.response;
};

/**
 * The message for a request that got no response, by where the app is running.
 *
 *   timed out    the same in both: the link is slow, not missing.
 *   browser      "No connection" — the web console needs one for everything.
 *   desktop      only a request the local database could not answer reaches the
 *                network at all, so the person was doing one of the few things
 *                that need the server. Saying "no connection, check your
 *                network" there reads as "the app is broken offline"; the truth
 *                is that this action needs the internet and the rest keeps
 *                working.
 */
export const noResponseMessageKey = (
  { desktop, timedOut }: { desktop: boolean; timedOut: boolean },
): "errors.timeout" | "errors.offline" | "errors.needsInternet" =>
  timedOut ? "errors.timeout" : desktop ? "errors.needsInternet" : "errors.offline";

/** The one the app uses. */
export const connectivity = createConnectivity(
  typeof navigator === "undefined" || navigator.onLine !== false,
);
