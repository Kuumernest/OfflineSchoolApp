// OfflineSchoolApp/shared/studentName.js
"use strict";

/**
 * A student's name, from whichever field actually holds it.
 *
 * Three fields carry a name in this database and the order matters:
 *
 *   · `studentName` is the schema's field — a pre-save hook computes it from
 *     firstName/lastName, and EVERY current record has it;
 *   · `name` is legacy. It is not in the schema, so it cannot be written any
 *     more, but older documents still carry it and Mongoose returns it on a
 *     lean read;
 *   · firstName/lastName is the last resort, for a record saved before the
 *     hook ran.
 *
 * Reading only `name` and firstName/lastName — which is what the printing,
 * export, promotion and portal code did at first — silently blanks every
 * student whose name lives solely in `studentName`. On this school's roster
 * that was 5 of 16, and it looked exactly like patchy data entry rather than
 * like a bug, which is why it survived several rounds of review.
 *
 * ── Why it is here rather than in the backend ─────────────────────────────
 *
 * The desktop application answers the arrears list from a local mirror when
 * there is no connection, and every row in it is a name. If the two
 * implementations of this function ever differed, the same pupil would appear
 * named on one platform and blank on the other — which is precisely the failure
 * the comment above describes surviving several rounds of review the first time.
 *
 * backend/src/utils/studentName.js re-exports this, so its eleven importers are
 * unchanged and there is still only one definition.
 *
 * @returns {string} the name, or "" when there genuinely is not one
 */
const displayName = (student) => {
  if (!student) return "";

  const stored = student.studentName ?? student.name;
  if (stored && String(stored).trim()) return String(stored).trim();

  return [student.firstName, student.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
};

/** Sorts by name with unnamed records last, for rosters and registers. */
const byName = (a, b) => {
  const an = displayName(a);
  const bn = displayName(b);
  if (!an && !bn) return 0;
  if (!an) return 1;
  if (!bn) return -1;
  return an.localeCompare(bn, undefined, { sensitivity: "base" });
};

module.exports = { displayName, byName };
