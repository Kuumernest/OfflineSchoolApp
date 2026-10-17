// backend/src/services/readiness.service.js
"use strict";

/**
 * Whether this process can serve a school right now: the database answers.
 *
 * GET /api/health is liveness — the process is up — and answers 200 even with
 * the database gone, which is right for "should this container be restarted"
 * (no: a restart does not bring Atlas back) and wrong for "should traffic be
 * sent here". GET /api/health/ready answers that second question: 200 only
 * when the connection is open AND a ping comes back within the timeout, 503
 * otherwise. The Docker healthcheck reads it (docker-compose.yml), which marks
 * the container unhealthy without restarting it.
 *
 * Says nothing about the database beyond up or down: no host, no error text.
 */

const LABELS = ["disconnected", "connected", "connecting", "disconnecting"];

/**
 * @param {import("mongoose").Connection} connection
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ready: boolean, database: string }>}
 */
async function checkReadiness(connection, timeoutMs = 3000) {
  const database = LABELS[connection.readyState] ?? "unknown";
  if (connection.readyState !== 1 || !connection.db) return { ready: false, database };

  let timer;
  try {
    await Promise.race([
      connection.db.admin().ping(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    return { ready: true, database };
  } catch {
    return { ready: false, database: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the unique and TTL indexes the data depends on are in place, from
 * the last index verification (indexCheck.service indexState()).
 *
 *   "ok"          verified, nothing critical missing or incompatible
 *   "incomplete"  some are: duplicates can be written. Not ready in
 *                 production — so the health check, and any monitor on it,
 *                 shows the deployment is not finished (docs/17, Index
 *                 provisioning). nginx does not route on health, so this
 *                 alerts; it does not take the API offline.
 *   "unchecked"   no verification has completed (it failed, or is running).
 *                 Reported as such, never as "ok"; not held against readiness,
 *                 since a check that cannot run must not close the school.
 *
 * Outside production the indexes are reported but never block readiness.
 *
 * @param {{ checkedAt: Date|null, criticalProblems: number|null }} state
 * @param {{ production: boolean }} opts
 * @returns {{ ok: boolean, indexes: "ok"|"incomplete"|"unchecked", criticalProblems: number|null }}
 */
function indexReadiness(state, { production }) {
  if (!state?.checkedAt) return { ok: true, indexes: "unchecked", criticalProblems: null };
  if (state.criticalProblems > 0) {
    return { ok: !production, indexes: "incomplete", criticalProblems: state.criticalProblems };
  }
  return { ok: true, indexes: "ok", criticalProblems: 0 };
}

module.exports = { checkReadiness, indexReadiness };
