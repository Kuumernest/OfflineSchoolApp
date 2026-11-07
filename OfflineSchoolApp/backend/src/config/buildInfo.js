// backend/src/config/buildInfo.js
"use strict";

/**
 * Which build is running — for GET /api/version.
 *
 * Without it there was no way to tell from outside whether a deploy had
 * happened: /api/health says the server is up, not what it is running.
 *
 * The commit comes from the host: Render sets RENDER_GIT_COMMIT (and
 * RENDER_GIT_BRANCH) on every deploy; elsewhere set GIT_COMMIT / GIT_BRANCH
 * at build time. Only a 7–40 character hex commit and a plain branch name are
 * reported — never an arbitrary environment value.
 */

const STARTED_AT = new Date().toISOString();
const { version } = require("../../package.json");

const HEX = /^[0-9a-f]{7,40}$/i;
const BRANCH = /^[\w./-]{1,100}$/;

function buildInfo(env = process.env) {
  const rawCommit = env.RENDER_GIT_COMMIT || env.GIT_COMMIT || "";
  const rawBranch = env.RENDER_GIT_BRANCH || env.GIT_BRANCH || "";
  const commit = HEX.test(rawCommit) ? rawCommit.toLowerCase() : null;
  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    branch:      BRANCH.test(rawBranch) ? rawBranch : null,
    version,
    startedAt:   STARTED_AT,
    node:        process.version,
  };
}

/** GET /api/version — public, never cached. */
function versionHandler(_req, res) {
  res.set("Cache-Control", "no-store").json(buildInfo());
}

module.exports = { buildInfo, versionHandler, STARTED_AT };
