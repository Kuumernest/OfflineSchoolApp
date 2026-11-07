// backend/src/services/offlineSettings.service.js
"use strict";

/**
 * The per-school switch for per-user local data on phones (docs/40 D7).
 *
 * One reader, so the default lives in one place: a school created before the
 * setting existed, a school that cannot be read, a super_admin outside any
 * school — all OFF. Off is the phone's long-standing behaviour, so every
 * failure lands on the behaviour nobody has to be told about.
 */

const School = require("../db/models/School");

const OFF = Object.freeze({ perUserLocalData: false });

/** { perUserLocalData } from a school document (lean or hydrated), defaults applied. */
const resolveOfflineSettings = (school) => ({
  perUserLocalData: school?.settings?.offline?.perUserLocalData === true,
});

/** What a signed-in user's phone should do. Never throws. */
const offlineSettingsForUser = async (user) => {
  try {
    const schoolId = user?.schoolId ? String(user.schoolId) : null;
    if (!schoolId || user?.role === "super_admin") return { ...OFF };
    if (!/^[0-9a-f]{24}$/i.test(schoolId)) return { ...OFF };
    const school = await School.findById(schoolId).select("settings.offline").lean();
    return resolveOfflineSettings(school);
  } catch (err) {
    console.warn("[offlineSettings] could not read the school — off:", err.message);
    return { ...OFF };
  }
};

module.exports = { resolveOfflineSettings, offlineSettingsForUser, OFF };
