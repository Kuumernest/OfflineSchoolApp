// desktop/src/main/api/names.js
"use strict";

/**
 * Class and subject names compare as the server's unique indexes do
 * (backend/src/db/nameCollation.js: locale "en", strength 2): case ignored,
 * accents kept — "Biology" = "biology", "Lycée" ≠ "Lycee". The server refuses a
 * duplicate name on create AND rename (409); a handler here that accepted one
 * offline would queue a write the server is certain to refuse, and the outbox
 * would block on it. So a local handler that finds a clash declines (returns
 * null) and lets the server answer.
 */

const sameName = (a, b) =>
  typeof a === "string" && typeof b === "string" &&
  a.trim().localeCompare(b.trim(), "en", { sensitivity: "accent" }) === 0;

const notDeleted = (row) => !row?.deletedAt;

/** Another class in the school, not deleted, already called `name`. */
function classNameTaken(docs, schoolId, name, exceptId = null) {
  return docs.find("class", { schoolId })
    .some((c) => notDeleted(c) && String(c._id) !== String(exceptId) && sameName(c.name, name));
}

/** Another subject in the class (either spelling of the link), not deleted, already called `name`. */
function subjectNameTaken(docs, schoolId, classId, name, exceptId = null) {
  return [...docs.find("subject", { schoolId, classId }), ...docs.find("subject", { schoolId, class: classId })]
    .some((s) => notDeleted(s) && String(s._id) !== String(exceptId) && sameName(s.name, name));
}

module.exports = { sameName, classNameTaken, subjectNameTaken };
