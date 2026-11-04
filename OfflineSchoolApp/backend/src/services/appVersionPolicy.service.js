// backend/src/services/appVersionPolicy.service.js
"use strict";

/**
 * Which phone builds may sync into a school (docs/40 §8.9).
 *
 * A school with per-user local data ON has phones whose changes were moved out
 * of the shared file into per-account files. An older build reads the shared
 * file only, and its backfill would queue the moved changes again. So such a
 * school refuses phone builds that do not understand per-user local data, at
 * the moments a phone gets a session (sign-in, refresh) and when it syncs or
 * writes. A school with the switch OFF never refuses on version: it gets a
 * warning header and nothing else.
 *
 * How a phone says what it is (every request, mobile/src/config/appBuild.js):
 *
 *   X-App-Platform     android | ios           (web / desktop: never refused)
 *   X-App-Version      the app version, for logs only
 *   X-App-Data-Format  the local data format this build reads and writes
 *
 * Builds from before this policy send none of these. They are recognised by
 * the phone HTTP stacks' own User-Agent (okhttp on Android, CFNetwork/Darwin
 * on iOS) and count as data format 0. Anything else without the headers — a
 * browser, the desktop's main process, a script — is not a phone and is never
 * refused.
 *
 * super_admin accounts have no school switch (offlineSettings.service) and
 * are never refused.
 */

const { offlineSettingsForUser } = require("./offlineSettings.service");

/** The local data format whose builds understand per-user local data. */
const MIN_MOBILE_DATA_FORMAT_PER_USER = 1;

const UPDATE_REQUIRED_STATUS = 426;
const UPDATE_REQUIRED_CODE   = "APP_UPDATE_REQUIRED";
const UPDATE_REQUIRED_MESSAGE =
  "Update the app to keep syncing. This school's data now needs a newer version of the app.";

/** Set on answers to an outdated phone in a school with the switch off. */
const WARNING_HEADER = "X-App-Update-Recommended";
const MIN_FORMAT_HEADER = "X-App-Min-Data-Format";

const MOBILE_PLATFORMS = new Set(["android", "ios", "mobile"]);
// The User-Agent React Native's networking sends when the app sets none.
const LEGACY_MOBILE_UA = /\b(okhttp|CFNetwork|Darwin)\//i;

/**
 * { kind: "mobile" | "other", dataFormat, version, identified }
 * dataFormat is 0 for a phone that did not say (a build from before this).
 */
const classifyClient = (req) => {
  const h = (name) => {
    const v = req.get ? req.get(name) : req.headers?.[name.toLowerCase()];
    return typeof v === "string" ? v.trim() : "";
  };
  const platform = h("X-App-Platform").toLowerCase();
  const version  = h("X-App-Version") || null;
  const formatRaw = h("X-App-Data-Format");
  const parsed = /^\d+$/.test(formatRaw) ? Number(formatRaw) : 0;

  if (platform) {
    if (!MOBILE_PLATFORMS.has(platform)) return { kind: "other", dataFormat: parsed, version, identified: true };
    return { kind: "mobile", dataFormat: parsed, version, identified: true };
  }
  if (LEGACY_MOBILE_UA.test(h("User-Agent"))) {
    return { kind: "mobile", dataFormat: 0, version: null, identified: false };
  }
  return { kind: "other", dataFormat: 0, version: null, identified: false };
};

/** True for a phone build that cannot read per-user local data. */
const isOutdatedMobile = (client) =>
  client.kind === "mobile" && client.dataFormat < MIN_MOBILE_DATA_FORMAT_PER_USER;

const updateRequiredBody = () => ({
  success:       false,
  code:          UPDATE_REQUIRED_CODE,
  message:       UPDATE_REQUIRED_MESSAGE,
  minDataFormat: MIN_MOBILE_DATA_FORMAT_PER_USER,
});

/**
 * The decision for this request and this account.
 * @returns {Promise<"ok" | "warn" | "refuse">}
 */
const verdictFor = async (req, user) => {
  const client = classifyClient(req);
  if (!isOutdatedMobile(client)) return "ok";
  // Only an outdated phone costs a school read; every current client is free.
  const settings = await offlineSettingsForUser(user);
  return settings.perUserLocalData ? "refuse" : "warn";
};

/**
 * For a route that has just authenticated `user`: answers 426 and returns
 * true when this build may not sync into the user's school, sets the warning
 * header and returns false when it is merely outdated, false otherwise.
 * Never throws: a failure lets the request through, as before this policy.
 */
const refuseOutdatedMobile = async (req, res, user) => {
  try {
    const verdict = await verdictFor(req, user);
    if (verdict === "ok") return false;
    res.set(MIN_FORMAT_HEADER, String(MIN_MOBILE_DATA_FORMAT_PER_USER));
    if (verdict === "warn") {
      res.set(WARNING_HEADER, "1");
      return false;
    }
    console.warn(`[appVersion] refused an outdated phone build for ${user?._id ?? user?.id} (${req.method} ${req.originalUrl})`);
    res.status(UPDATE_REQUIRED_STATUS).json(updateRequiredBody());
    return true;
  } catch (err) {
    console.warn("[appVersion] policy check failed — allowed:", err.message);
    return false;
  }
};

/**
 * Middleware, after authenticate/optionalAuthenticate. `writesOnly` lets
 * reads through (for the app-wide mount: an old phone's danger is what it
 * sends, and its reads cost nothing). No req.user: nothing to decide.
 */
const requireSupportedMobileBuild = ({ writesOnly = false } = {}) => async (req, res, next) => {
  if (!req.user) return next();
  if (writesOnly && ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (await refuseOutdatedMobile(req, res, req.user)) return;
  return next();
};

module.exports = {
  MIN_MOBILE_DATA_FORMAT_PER_USER,
  UPDATE_REQUIRED_STATUS,
  UPDATE_REQUIRED_CODE,
  UPDATE_REQUIRED_MESSAGE,
  WARNING_HEADER,
  MIN_FORMAT_HEADER,
  classifyClient,
  isOutdatedMobile,
  verdictFor,
  refuseOutdatedMobile,
  requireSupportedMobileBuild,
};
