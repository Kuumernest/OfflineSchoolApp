// backend/src/db/nameCollation.js
"use strict";

/**
 * How class and subject NAMES compare: case-insensitively ("Biology" =
 * "biology" = "BIOLOGY"), accents still distinct ("Lycée" ≠ "Lycee").
 * Strength 2 = base letters + accents, not case.
 *
 * One definition, used by the unique indexes (models/Class.js,
 * models/Subject.js) AND by the routes' "already exists" checks
 * (routes/admin.routes.js): a check that compared differently from its index
 * would let a name through to a raw duplicate-key error, or refuse one the
 * index allows.
 */
module.exports = { NAME_COLLATION: { locale: "en", strength: 2 } };
