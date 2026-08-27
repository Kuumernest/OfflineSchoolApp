// backend/src/services/documentVerify.service.js
"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");

const DocumentVerification = require("../db/models/DocumentVerification");
const School               = require("../db/models/School");

/**
 * Verifiable documents.
 *
 * The mechanic: when a transcript or report card is rendered, a verification
 * row is created (or found — reprints reuse it) and the document is printed
 * with a QR code and a short typed code. Anyone holding the paper can resolve
 * either to a public page showing what the school's records say — no account,
 * no API knowledge, just a URL.
 *
 * The code is the whole secret. It is random, not derived from the student or
 * the document, so knowing one code reveals nothing about any other, and a
 * code cannot be constructed for a student who was never issued the document.
 */

/**
 * No 0/O, 1/I/L, and no vowels — a code that cannot spell anything is a code
 * nobody has to apologise for. 28 symbols at 12 characters is ~57 bits:
 * unguessable through a rate-limited endpoint by a margin of billions.
 */
const ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

const mintCode = () => {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return code;
};

/**
 * What a human actually types: dashes, spaces, lowercase. Everything cosmetic
 * is stripped before lookup. Characters outside the alphabet simply fail the
 * lookup — that is what excluding the ambiguous ones was for.
 */
const normalizeCode = (raw) =>
  String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/** XXXX-XXXX-XXXX — the only form the code is ever shown in. */
const formatCode = (code) =>
  String(code).replace(/(.{4})(?=.)/g, "$1-");

/** The public page for a code. `origin` comes from the printing request. */
const verifyUrl = (origin, code) =>
  `${origin ?? ""}/api/verify/${formatCode(code)}`;

/**
 * The verification row for a document, minted on first print.
 *
 * Reprints REUSE the code and refresh the snapshot: the paper in circulation
 * keeps working, and the page always answers with the school's current
 * record. A result corrected after printing therefore shows up as a mismatch
 * between page and paper — which is the check working, not failing.
 */
const ensure = async ({ schoolId, kind, studentId, examId, snapshot }) => {
  const key = {
    schoolId: String(schoolId),
    kind,
    studentId: String(studentId),
    examId: examId ? String(examId) : "-",
  };

  const existing = await DocumentVerification.findOneAndUpdate(
    key,
    {
      $set: { snapshot, refreshedAt: new Date() },
      $inc: { printCount: 1 },
    },
    { new: true }
  ).lean();
  if (existing) return existing;

  // First print. The unique code index can collide with astronomically low
  // probability, and the document key can collide when two prints race — in
  // either case one insert wins and the retry finds it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const created = await DocumentVerification.create({
        ...key,
        code: mintCode(),
        snapshot,
      });
      return created.toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const found = await DocumentVerification.findOne(key).lean();
      if (found) return found;
    }
  }
  throw new Error("Could not issue a verification code");
};

/**
 * Resolve a code to what the school's records say.
 *
 * Revoked codes answer "revoked", not "not found": a school that has
 * withdrawn a document wants the person holding it to know that, which a
 * silent 404 would not say.
 */
const verify = async (rawCode) => {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return { status: "not_found" };

  const record = await DocumentVerification.findOne({ code, deletedAt: null }).lean();
  if (!record) return { status: "not_found" };

  const school = await School.findOne({ _id: record.schoolId })
    .select("name logo logoUrl address phone email")
    .lean();

  return {
    status: record.revokedAt ? "revoked" : "valid",
    kind: record.kind,
    code: formatCode(record.code),
    snapshot: record.snapshot,
    issuedAt: record.issuedAt,
    refreshedAt: record.refreshedAt,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason ?? null,
    school: school
      ? {
          name:    school.name ?? null,
          logo:    school.logo ?? school.logoUrl ?? null,
          address: school.address ?? null,
          phone:   school.phone ?? null,
          email:   school.email ?? null,
        }
      : null,
  };
};

/**
 * The block a printed document embeds: QR plus typed code plus URL.
 * Returns null rather than throwing — a document that cannot get its QR is
 * still a valid document, exactly like the ID card's rule.
 */
const printableBlock = async ({ schoolId, kind, studentId, examId, snapshot, origin }) => {
  try {
    const record = await ensure({ schoolId, kind, studentId, examId, snapshot });
    const url = verifyUrl(origin, record.code);
    const qrSvg = await QRCode.toString(url, {
      type: "svg", margin: 0, width: 120, errorCorrectionLevel: "M",
    });
    return { code: formatCode(record.code), url, qrSvg };
  } catch (err) {
    console.warn("[documentVerify] could not issue code:", err.message);
    return null;
  }
};

/** Every code issued for one student, newest activity first — the office view. */
const listForStudent = async ({ schoolId, studentId }) =>
  DocumentVerification.find({
    schoolId: String(schoolId), studentId: String(studentId), deletedAt: null,
  }).sort({ refreshedAt: -1 }).lean();

/**
 * Revoke or restore a code.
 *
 * Revoking does not delete: the public page answers "withdrawn by the
 * school", which is what the person holding the paper needs to hear.
 * Restoring clears it entirely — a revocation that turned out to be a
 * mistake should leave no scar on the document's page.
 */
const setRevoked = async ({ schoolId, id, revoked, reason, by }) => {
  const row = await DocumentVerification.findOneAndUpdate(
    { _id: String(id), schoolId: String(schoolId), deletedAt: null },
    {
      $set: revoked
        ? {
            revokedAt: new Date(),
            revokeReason: String(reason ?? "").trim() || null,
            revokedBy: by ?? null,
          }
        : { revokedAt: null, revokeReason: null, revokedBy: null },
    },
    { new: true }
  ).lean();

  if (!row) {
    const err = new Error("Verification code not found");
    err.status = 404;
    throw err;
  }
  return row;
};

module.exports = {
  ensure, verify, printableBlock,
  listForStudent, setRevoked,
  mintCode, normalizeCode, formatCode, verifyUrl,
  CODE_LENGTH, ALPHABET,
};
