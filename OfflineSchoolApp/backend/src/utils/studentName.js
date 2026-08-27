// backend/src/utils/studentName.js
"use strict";

/**
 * Re-exported from OfflineSchoolApp/shared/studentName.js.
 *
 * The definition moved there because the desktop application needs the same
 * function: it answers the arrears list from a local mirror, and every row in
 * that list is a name. Two implementations would eventually differ and the same
 * pupil would render named on one platform and blank on the other — which is
 * exactly the bug the notes over there describe surviving several rounds of
 * review the first time it happened.
 *
 * This file stays so that its eleven importers do not have to change, and so
 * that "where does a student's name come from" still has one answer.
 */

module.exports = require("../../../shared/studentName");
