// desktop/src/main/sync/connectivity.js
"use strict";

/**
 * Noticing that the connection has come back.
 *
 * ── Why the engine's timers were not enough ───────────────────────────────
 *
 * A request that failed for want of a network backs off — 5 s, 15 s, 1 min,
 * 5 min, then 10 min (db/outbox.js). The engine retries a cycle every 15 s
 * while offline, but a cycle only sends what is DUE, so a payment taken during
 * a long outage could sit for ten more minutes after the connection returned.
 * The engine now brings those forward itself on the first cycle that reaches
 * the server (engine.js); this makes that moment come sooner, and on the
 * connection's own signal rather than the next tick of a timer.
 *
 * ── How ───────────────────────────────────────────────────────────────────
 *
 *   online   the normal state. NOTHING runs: no timer, no probe. It is left
 *            when the engine reports a cycle that could not reach the server,
 *            when the window's `offline` event arrives, or when the OS says
 *            the machine has no network.
 *   offline  a cheap local check (Electron's net.isOnline(), no traffic) every
 *            few seconds. When the OS says the machine is online — or the
 *            window's `online` event says so — wait a moment for it to settle
 *            (a flapping Wi-Fi link goes up and down several times a second),
 *            then ask the server's /api/health. Only an answer from the
 *            server counts: a network with no route to the school's server is
 *            still offline as far as sync is concerned. A probe that fails
 *            spaces out the next one.
 *
 * On the server answering: back to online, and onReconnect() — which runs a
 * cycle with network backoffs brought forward (engine.reconnected()).
 *
 * Everything is injected, so this runs in a plain node test with no Electron.
 */

const connectivity = ({
  isOnline = () => true,
  probe,
  onReconnect = () => {},
  pollMs = 3_000,
  settleMs = 1_500,
  probeBackoffMs = [5_000, 15_000, 30_000],
  log = (msg) => console.log(`[net] ${msg}`),
}) => {
  let state     = "online";
  let started   = false;
  let pollTimer = null;
  let settleTimer = null;
  let probing   = false;
  let failures  = 0;
  let nextProbeAt = 0;

  const unref = (t) => { t?.unref?.(); return t; };

  const stopTimers = () => {
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(settleTimer); settleTimer = null;
  };

  const goOnline = ({ reconnected }) => {
    if (state === "online") return;
    state = "online";
    failures = 0;
    stopTimers();
    if (reconnected) {
      log("server reachable again");
      try {
        const r = onReconnect();
        if (r && typeof r.catch === "function") r.catch(() => { /* the engine reports its own */ });
      } catch { /* the engine reports its own */ }
    }
  };

  const goOffline = (why) => {
    if (!started) return;
    if (state === "offline") {
      // Already offline: an "offline" signal cancels a settle in progress.
      clearTimeout(settleTimer); settleTimer = null;
      return;
    }
    state = "offline";
    failures = 0;
    nextProbeAt = 0;
    log(`offline (${why})`);
    clearTimeout(settleTimer); settleTimer = null;
    pollTimer = unref(setInterval(poll, pollMs));
  };

  const runProbe = async () => {
    if (probing || state !== "offline") return;
    probing = true;
    let ok = false;
    try { ok = Boolean(await probe()); } catch { ok = false; }
    probing = false;
    if (!started || state !== "offline") return;
    if (ok) { goOnline({ reconnected: true }); return; }
    failures++;
    nextProbeAt = Date.now() + probeBackoffMs[Math.min(failures - 1, probeBackoffMs.length - 1)];
  };

  /** The machine looks online: confirm after it has stayed so for settleMs. */
  const candidate = () => {
    if (state !== "offline" || settleTimer || probing) return;
    if (Date.now() < nextProbeAt) return;
    settleTimer = unref(setTimeout(() => {
      settleTimer = null;
      // Down again within the settle time: a flap. Nothing to do.
      let up = true;
      try { up = isOnline(); } catch { up = true; }
      if (up) void runProbe();
    }, settleMs));
  };

  function poll() {
    if (state !== "offline") return;
    let up = true;
    try { up = isOnline(); } catch { up = true; }
    if (up) candidate();
    else { clearTimeout(settleTimer); settleTimer = null; }
  }

  return {
    start() {
      if (started) return;
      started = true;
      let up = true;
      try { up = isOnline(); } catch { up = true; }
      if (!up) goOffline("no network at start");
    },

    stop() {
      started = false;
      stopTimers();
      state = "online";
    },

    /** The window's online / offline events, relayed by the preload. */
    signal(online) {
      if (!started) return;
      if (online) {
        // An "online" while we believe we are online is nothing new. While
        // offline it is a hint to confirm now rather than at the next poll —
        // and it may come before the probe backoff has run out, which it
        // overrides: it is a fresh event, not a repeat of the last failure.
        if (state === "offline") { nextProbeAt = 0; candidate(); }
      } else {
        goOffline("the window lost its connection");
      }
    },

    /** Every phase the engine publishes. */
    engineStatus(phase) {
      if (!started) return;
      if (phase === "offline") goOffline("the server could not be reached");
      // A cycle that reached the server: online, without another cycle — the
      // engine has just done one.
      else if (phase === "idle" || phase === "blocked") goOnline({ reconnected: false });
    },

    state: () => state,
  };
};

module.exports = { connectivity };
