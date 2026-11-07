// backend/src/services/staffNumber.service.js
"use strict";

/**
 * The one place a member of staff's number is made.
 *
 * Mirrors services/admissionNumber.service.js, which does the same for pupils:
 *
 *   FORMAT     CODE-STF-NNN — the school's code (School.code, else the id's
 *              first alphanumerics, else "SCH", exactly as a pupil number),
 *              "STF", and at least three digits, zero-padded, that simply
 *              grow past 999 (GVA00-STF-1000).
 *
 *   SEQUENCE   one per school (and code). The next number is one past the
 *              highest already held IN THIS SHAPE by anybody in the school —
 *              an administrator's override that happens to look like
 *              GVA00-STF-040 included — so a number already printed on a card
 *              or a payslip is never issued again.
 *
 *   RACES      a counter, not read-the-highest-and-add-one: it is first raised
 *              to the highest issued ($max never lowers it), then incremented
 *              atomically, so two creates at the same moment take two numbers.
 *              The unique index (schoolId, staffNo) is the second line: a
 *              write that meets it takes a fresh number and tries again.
 *
 *   GAPS       a number is taken before the account is written. A create that
 *              then fails (a bad email, a lost connection) leaves that number
 *              unused — a gap, never a duplicate. Gaps are acceptable; the
 *              alternative, reusing a number, is not.
 *
 *   ON DEVICES never. A teacher created offline on a phone is numbered by the
 *              server when that create arrives; two devices numbering on their
 *              own would collide.
 *
 * Role-agnostic: STAFF_NUMBER_ROLES says who is numbered. Teachers only, for
 * now, as the school asked; adding "bursar" there numbers bursars from the
 * same sequence, and the boot backfill picks the existing ones up.
 */

const Counter = require("../db/models/Counter");
const { schoolCodeFor } = require("./admissionNumber.service");

/** Who carries a staff number. */
const STAFF_NUMBER_ROLES = Object.freeze(["teacher"]);

/** Change the shape here, and only here. */
const FORMAT = Object.freeze({ separator: "-", marker: "STF", minDigits: 3 });

/** An override: letters, digits and - / . _ ; starts with a letter or digit. */
const MAX_LENGTH = 32;
const ALLOWED = /^[A-Z0-9][A-Z0-9\-/._]*$/;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function formatStaffNo(code, seq) {
  const { separator: s, marker, minDigits } = FORMAT;
  return `${code}${s}${marker}${s}${String(seq).padStart(minDigits, "0")}`;
}

const shapeOf = (code) =>
  new RegExp(`^${escapeRegex(code)}${escapeRegex(FORMAT.separator)}${FORMAT.marker}${escapeRegex(FORMAT.separator)}(\\d+)$`);

/** The sequence in a number of this code's shape, or null. */
function sequenceOf(value, code) {
  const m = shapeOf(code).exec(String(value ?? "").trim().toUpperCase());
  return m ? parseInt(m[1], 10) : null;
}

const counterId = (schoolId, code) => `staffNo:${String(schoolId)}:${code}`;

const User = () => require("../db/models/User");

/** The highest sequence any account of this school holds in this shape. */
async function highestIssued(schoolId, code) {
  const rows = await User().find({ schoolId: String(schoolId), staffNo: shapeOf(code) })
    .select("staffNo").lean();
  let max = 0;
  for (const r of rows) {
    const seq = sequenceOf(r.staffNo, code);
    if (seq != null && seq > max) max = seq;
  }
  return max;
}

/** Raises the counter to at least `seq` (never lowers it). */
async function raiseCounter(schoolId, code, seq) {
  const _id = counterId(schoolId, code);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await Counter.updateOne(
        { _id },
        { $max: { seq }, $setOnInsert: { schoolId: String(schoolId) } },
        { upsert: true }
      );
      return;
    } catch (err) {
      // Two first-ever numbers racing on the upsert: one inserts, the other
      // gets E11000 and runs again as an update.
      if (err?.code !== 11000 || attempt >= 2) throw err;
    }
  }
}

/**
 * Take the next staff number for a school. Taken is taken: the caller writes
 * it, and if that write fails the number is a gap.
 */
async function nextStaffNo(schoolId) {
  if (!schoolId) throw new Error("nextStaffNo: a school is required");
  const code = await schoolCodeFor(schoolId);
  await raiseCounter(schoolId, code, await highestIssued(schoolId, code));
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId(schoolId, code) }, { $inc: { seq: 1 } }, { returnDocument: "after" }
  ).lean();
  return formatStaffNo(code, counter.seq);
}

/** An E11000 raised by the (schoolId, staffNo) index, and not another one. */
const isStaffNoClash = (err) =>
  err?.code === 11000 &&
  (Boolean(err?.keyPattern?.staffNo) || /staffNo/.test(String(err?.message ?? "")));

/**
 * Run `write(staffNo)` with a freshly taken number, taking another if the
 * write meets the unique index (an override typed a moment ago, say). Any
 * other error is the caller's, as it would have been without a number.
 */
async function withStaffNo(schoolId, write, { attempts = 5 } = {}) {
  // No school, no sequence: written without a number (the backfill numbers it
  // once it has a school).
  if (!schoolId) return write(undefined);
  for (let i = 0; ; i += 1) {
    const staffNo = await nextStaffNo(schoolId);
    try {
      return await write(staffNo);
    } catch (err) {
      if (!isStaffNoClash(err) || i >= attempts - 1) throw err;
    }
  }
}

/**
 * Give an existing account a number if — and only if — it has none.
 * Conditional on the row still having none, so it can never overwrite a
 * number (a concurrent assignment, an override) and running it twice is safe.
 *
 * @returns {Promise<string|null>} the account's number afterwards
 */
async function ensureStaffNo(userId) {
  const U = User();
  const user = await U.findById(String(userId)).select("schoolId role staffNo").lean();
  if (!user) return null;
  if (typeof user.staffNo === "string" && user.staffNo) return user.staffNo;
  if (!user.schoolId || !STAFF_NUMBER_ROLES.includes(user.role)) return null;
  const numberless = { $or: [{ staffNo: { $exists: false } }, { staffNo: null }, { staffNo: "" }] };
  await withStaffNo(user.schoolId, (staffNo) =>
    U.updateOne({ _id: user._id, ...numberless }, { $set: { staffNo } }));
  return (await U.findById(user._id).select("staffNo").lean())?.staffNo ?? null;
}

/**
 * An administrator's number, cleaned and checked. Upper-cased so "gva00-stf-7"
 * and "GVA00-STF-7" are one number, as the generated ones always are.
 *
 * @returns {{ value: string } | { error: string }}
 */
function normaliseStaffNo(raw) {
  if (raw === null || raw === undefined) return { error: "A staff number cannot be removed" };
  const value = String(raw).trim().toUpperCase();
  if (!value) return { error: "A staff number cannot be removed" };
  if (value.length > MAX_LENGTH) return { error: `A staff number is at most ${MAX_LENGTH} characters` };
  if (!ALLOWED.test(value)) {
    return { error: "A staff number may use only letters, digits and - / . _" };
  }
  return { value };
}

/**
 * After an override: if it is in this school's shape, the sequence moves past
 * it, so the next generated number does not run into it.
 */
async function noteStaffNo(schoolId, value) {
  if (!schoolId || !value) return;
  const code = await schoolCodeFor(schoolId);
  const seq = sequenceOf(value, code);
  if (seq != null) await raiseCounter(schoolId, code, seq);
}

/**
 * Number every account that should have one and has none.
 *
 * Idempotent: an account with a number is never touched, and the write is
 * conditional on it still having none. Deterministic: per school, oldest
 * first (createdAt, then _id). Inactive and removed teachers included — the
 * school's paperwork for them exists. Never throws per account: a failure is
 * counted and the rest go on.
 *
 * @param {object} [opts]
 * @param {string}  [opts.schoolId]  one school only
 * @param {boolean} [opts.dryRun]    count, write nothing
 * @param {(line:string)=>void} [opts.log]
 * @returns {Promise<{ missing: number, assigned: number, failed: number,
 *   bySchool: Record<string, number> }>}
 */
async function backfillStaffNumbers({ schoolId = null, dryRun = false, log = () => {} } = {}) {
  const U = User();
  const filter = {
    role: { $in: STAFF_NUMBER_ROLES },
    schoolId: schoolId ? String(schoolId) : { $nin: [null, ""] },
    $or: [{ staffNo: { $exists: false } }, { staffNo: null }, { staffNo: "" }],
  };
  const rows = await U.find(filter).select("_id schoolId createdAt name")
    .sort({ schoolId: 1, createdAt: 1, _id: 1 }).lean();
  const bySchool = {};
  let assigned = 0, failed = 0;
  for (const r of rows) {
    const sid = String(r.schoolId);
    bySchool[sid] = (bySchool[sid] ?? 0) + 1;
    if (dryRun) continue;
    try {
      const n = await ensureStaffNo(r._id);
      if (n) { assigned += 1; log(`[staffNo] ${sid} ${r._id} → ${n}`); }
    } catch (err) {
      failed += 1;
      log(`[staffNo] ${sid} ${r._id}: could not number — ${err.message}`);
    }
  }
  return { missing: rows.length, assigned, failed, bySchool };
}

module.exports = {
  STAFF_NUMBER_ROLES, FORMAT, MAX_LENGTH,
  formatStaffNo, sequenceOf, highestIssued, nextStaffNo, withStaffNo,
  ensureStaffNo, normaliseStaffNo, noteStaffNo, backfillStaffNumbers, isStaffNoClash,
};
