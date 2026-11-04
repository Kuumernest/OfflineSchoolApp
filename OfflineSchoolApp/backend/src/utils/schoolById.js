// backend/src/utils/schoolById.js
"use strict";

/**
 * Find a school by the id an account carries, whatever type its _id has.
 *
 * School._id is an ObjectId in the schema, but every account and record keeps
 * the school as a STRING (User.schoolId), and a school written outside
 * Mongoose — an import, an older seed — can have a plain string _id.
 * School.findById() casts to ObjectId and throws on such an id, so the
 * school-info routes the phone calls answered 500 for those schools.
 *
 * An id that is a valid ObjectId is looked up as one first; otherwise (or if
 * that finds nothing) by the id exactly as stored, without a cast. Returns a
 * plain object, or null.
 *
 * @param {string} id
 * @param {string} [fields]  space-separated projection, as .select() takes
 */
const findSchoolById = async (id, fields = "") => {
  const School = require("../db/models/School");
  const s = String(id ?? "").trim();
  if (!s) return null;
  if (/^[0-9a-f]{24}$/i.test(s)) {
    const doc = await School.findById(s).select(fields).lean();
    if (doc) return doc;
  }
  const names = String(fields).split(/\s+/).filter(Boolean);
  const projection = names.length ? Object.fromEntries(names.map((f) => [f, 1])) : undefined;
  return School.collection.findOne({ _id: s }, projection ? { projection } : {});
};

/**
 * The value to $match a found school on in an aggregate (which never casts):
 * its _id exactly as the document holds it — an ObjectId or a string.
 */
const matchId = (school) => school?._id ?? null;

module.exports = { findSchoolById, matchId };
