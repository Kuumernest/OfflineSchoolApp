// backend/src/config/syncWindow.js
"use strict";

/**
 * How far behind "now" a sync cursor is handed out — the commit-safety window.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * updatedAt is stamped by THIS PROCESS'S CLOCK when Mongoose builds the
 * document, not when the write commits. A write that is slow to land — a
 * transaction, a bulk insert of a class's fee charges, a replica that takes a
 * moment — becomes visible with an updatedAt that is already in the past. If a
 * pull ran in between and handed out a cursor beyond that updatedAt, the row
 * sorts BEFORE the cursor the moment it appears, and no later pull asks for it.
 * Not a delay: the device never hears of that row again.
 *
 * Both feeds therefore hand out a cursor that lags the server clock by this
 * window, and the next pull re-reads the overlap. A row whose write took less
 * than the window to commit is always delivered; the client applies a re-sent
 * row as the upsert it already is (same id, same updatedAt — a no-op).
 *
 * The same rewind is what keeps a FUTURE-dated row (an import that kept its
 * original timestamps, a server whose clock was wrong) from blinding the
 * desktop feed: the cursor a client stores is never later than now − window,
 * so a row dated next year can no longer carry the cursor past every row
 * written today. Such rows are re-sent on every pull until real time passes
 * them, which is the price, and the feed reports them (`futureDated`).
 *
 * Two minutes: far longer than any write in this system takes to commit (the
 * request timeout is ten, but a write still running after two is already
 * failing), and short enough that the overlap is a handful of rows.
 * Overridable for an installation that knows better; never below one second.
 */
const DEFAULT_MS = 120_000;

const safetyWindowMs = () => {
  const n = Number.parseInt(process.env.SYNC_SAFETY_WINDOW_MS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_MS;
};

/** The latest position a cursor may be handed out at, for a clock reading `now`. */
const safeHorizon = (now = new Date()) => new Date(now.getTime() - safetyWindowMs());

module.exports = { DEFAULT_MS, safetyWindowMs, safeHorizon };
