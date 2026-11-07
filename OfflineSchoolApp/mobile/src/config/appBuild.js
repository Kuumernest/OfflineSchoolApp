// mobile/src/config/appBuild.js
"use strict";

/**
 * What this build is, for the server and for the files on this phone
 * (docs/40 §8.9, "never downgrade a school with the per-user switch on").
 *
 * LOCAL_DATA_FORMAT is the local data layout this build reads and writes:
 *
 *   0  the shared file only (every build before per-user local data)
 *   1  per-user local data: device.db + schoolapp.u_<id>.db (docs/40 §8)
 *
 * It goes up ONLY when a build changes the files on the phone in a way an
 * older build would misread. Bumping it does two things:
 *   - device.db is stamped with it, and a build that finds a higher number
 *     there stops before touching any per-user store (db/deviceDb.js);
 *   - the server can then refuse older builds by raising its own minimum
 *     (backend/src/services/appVersionPolicy.service.js).
 */

/** The local data format this build understands (and writes). */
export const LOCAL_DATA_FORMAT = 1;

/** The answer a server gives a build too old for the school's data. */
export const UPDATE_REQUIRED_STATUS = 426;
export const UPDATE_REQUIRED_CODE   = "APP_UPDATE_REQUIRED";

// Loaded defensively: the checks run these modules in node, where neither
// package is the real one.
let _version = null;
const appVersion = () => {
  if (_version) return _version;
  try {
    const mod = require("expo-constants");
    const C = mod?.default ?? mod;
    _version = C?.expoConfig?.version ?? C?.manifest?.version ?? null;
  } catch { /* not in an app */ }
  _version = _version || "unknown";
  return _version;
};

const platform = () => {
  try {
    const os = require("react-native")?.Platform?.OS;
    if (os === "android" || os === "ios") return os;
  } catch { /* not in an app */ }
  return "mobile";
};

/** The headers every request to the server carries. */
export const appBuildHeaders = () => ({
  "X-App-Platform":    platform(),
  "X-App-Version":     appVersion(),
  "X-App-Data-Format": String(LOCAL_DATA_FORMAT),
});

/** True for the server's "this build is too old for your school". */
export const isUpdateRequiredAnswer = (status, body) =>
  status === UPDATE_REQUIRED_STATUS &&
  (body == null || body.code == null || body.code === UPDATE_REQUIRED_CODE);

export default {
  LOCAL_DATA_FORMAT, UPDATE_REQUIRED_STATUS, UPDATE_REQUIRED_CODE,
  appBuildHeaders, isUpdateRequiredAnswer,
};
