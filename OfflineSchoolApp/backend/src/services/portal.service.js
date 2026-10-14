// backend/src/services/portal.service.js
"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const Student        = require("../db/models/Student");
const GuardianAccess = require("../db/models/GuardianAccess");
const { displayName } = require("../utils/studentName");

/**
 * Guardian access to their children's records.
 *
 * A code, not an account. A parent here often has no email address, shares a
 * phone with the household, and will not remember a password set once in
 * September — so the school issues a short code, hands it over on paper, and
 * can revoke it. There is nothing to reset and nothing to support.
 *
 * One code covers ALL of a guardian's children. That is why this is keyed on a
 * GuardianAccess rather than on a Student: a parent with three at the school
 * should answer "what do we owe?" once, not three times.
 *
 * The code is the only secret, so the guard rails around it do the work:
 *
 *   · bcrypt-hashed, never stored in the clear — the office sees the last two
 *     characters and nothing more;
 *   · scoped to a fixed list of children, and every request re-checks that the
 *     child being asked about is on that list;
 *   · read-only — the portal has no write endpoint at all;
 *   · rate-limited, because an eight-character code is guessable given
 *     unlimited attempts.
 */

// No O/0, I/1, S/5 — a code is read off paper and typed by someone who did not
// choose it, and those pairs are where that goes wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
const CODE_LEN = 8;

const MAX_TRIES = 6;
const LOCK_MS   = 15 * 60_000;

/**
 * Two lifetimes, because they answer two different questions.
 *
 * The ACCESS token is what every request carries. It is a signed JWT checked
 * without a database read, so it is kept short: twenty minutes bounds how long
 * a copied token is worth anything. It used to be twelve hours, and it was the
 * only token there was - so a parent whose phone had been in a drawer
 * overnight was signed out by the first request of the morning, and typed
 * again a code they were handed once, on paper.
 *
 * The SESSION is how long a device stays signed in: ninety days from the
 * sign-in, renewing the access token as it goes. It lives on the
 * GuardianAccess row, so the office revoking the code ends it at once and the
 * parent tapping "sign out" ends it for that phone. Being offline does not end
 * it - a parent with no signal for a week is still that parent.
 */
const ACCESS_TOKEN_MINUTES = 20;
const SESSION_DAYS         = 90;
/** Sign-ins a guardian may hold at once. The oldest is dropped, not refused. */
const MAX_SESSIONS         = 10;

/** Random, from a CSPRNG — Math.random is not a secret generator. */
const generateCode = () => {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
};

/** Uppercase, punctuation stripped — "abcd efgh" and "ABCD-EFGH" are one code. */
const normalise = (code) =>
  String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The children an access covers, in the order the office chose. */
const childrenOf = async (schoolId, studentIds) => {
  const ids = (studentIds ?? []).map(String);

  const rows = await Student.find({
    _id: { $in: ids }, schoolId, deletedAt: null,
  }).select("studentName name firstName lastName enrollmentNo classId status").lean();

  const byId = new Map(rows.map((s) => [String(s._id), s]));

  // Mapped over the id list rather than over the query result, so the office's
  // ordering survives and a since-deleted child simply drops out.
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((s) => ({
      _id:          String(s._id),
      name:         displayName(s) || null,
      enrollmentNo: s.enrollmentNo ?? null,
      classId:      s.classId ?? null,
      status:       s.status,
    }));
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256, hex. The token is 256 random bits - see the schema note. */
const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

const signAccessToken = (access, sessionId) =>
  jwt.sign(
    {
      // A distinct audience. Without it a portal token would be accepted by the
      // ordinary authenticate middleware and a guardian would hold a staff
      // session.
      aud:      "portal",
      accessId: String(access._id),
      schoolId: String(access.schoolId),
      sid:      String(sessionId),
    },
    process.env.JWT_SECRET,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` }
  );

/**
 * Start a session on `access`, returning the token the device keeps.
 *
 * Expired sessions are swept here rather than by a scheduled job - there is no
 * other moment at which the row is certainly being written - and the cap drops
 * the least recently used sign-in, so a parent on their eleventh borrowed
 * phone loses the one they used least, not the one they are holding.
 */
const startSession = (access) => {
  const now          = new Date();
  const refreshToken = crypto.randomBytes(32).toString("base64url");

  const live = (access.sessions ?? [])
    .filter((s) => s.expiresAt && s.expiresAt > now)
    .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt));
  while (live.length >= MAX_SESSIONS) live.shift();

  const session = {
    _id:        uuidv4(),
    tokenHash:  hashToken(refreshToken),
    createdAt:  now,
    lastUsedAt: now,
    expiresAt:  new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  };
  access.sessions = [...live, session];

  return { refreshToken, session };
};

/** What the client is given at sign-in and at every refresh. */
const tokenResponse = (access, session, refreshToken) => ({
  token:            signAccessToken(access, session._id),
  expiresIn:        ACCESS_TOKEN_MINUTES * 60,
  ...(refreshToken ? { refreshToken } : {}),
  sessionExpiresAt: session.expiresAt,
});

// ─────────────────────────────────────────────────────────────────────────────
// ISSUING
// ─────────────────────────────────────────────────────────────────────────────

const assertOwnStudents = async (schoolId, ids) => {
  const found = await Student.find({
    _id: { $in: ids }, schoolId, deletedAt: null,
  }).select("_id studentName name firstName lastName enrollmentNo").lean();

  if (found.length !== ids.length) {
    const err = new Error("One or more children do not belong to this school");
    err.status = 404;
    err.code   = "STUDENT_NOT_FOUND";
    throw err;
  }

  // Sign-in is admission number + code. A child without an admission number
  // gives the parent nothing to type in the first field, so the code would be
  // issued, written down, handed over and then simply not work — with the
  // office having no way to tell why. Refusing here, by name, is the only
  // point at which that is cheap to fix.
  const numberless = found.filter((s) => !s.enrollmentNo || !String(s.enrollmentNo).trim());
  if (numberless.length) {
    const err = new Error(
      `These children have no admission number yet, so a code could not be used ` +
      `to sign in: ${numberless.map((s) => displayName(s) || s._id).join(", ")}`
    );
    err.status = 400;
    err.code   = "NO_ADMISSION_NUMBER";
    throw err;
  }
};

/**
 * Create or replace a guardian's access, returning the code ONCE.
 *
 * Passing an existing accessId re-issues the code for the same children, which
 * is what "the parent lost the slip" needs.
 */
const issueAccess = async ({ schoolId, accessId, studentIds, label, createdBy }) => {
  let access = accessId
    ? await GuardianAccess.findOne({ _id: accessId, schoolId, deletedAt: null })
    : null;

  if (accessId && !access) {
    const err = new Error("Guardian access not found");
    err.status = 404;
    throw err;
  }

  if (!access) {
    const ids = [...new Set((studentIds ?? []).map(String))];
    if (!ids.length) {
      const err = new Error("Choose at least one child");
      err.status = 400;
      err.code   = "NO_STUDENTS";
      throw err;
    }
    // Without this a caller could attach a child from another school and the
    // portal would serve their record quite happily.
    await assertOwnStudents(schoolId, ids);

    access = new GuardianAccess({
      schoolId, studentIds: ids, createdBy: createdBy ?? null,
    });
  }

  if (label !== undefined) access.label = label ? String(label).trim() : null;

  const code  = generateCode();
  const plain = normalise(code);

  access.codeHash    = await bcrypt.hash(plain, 10);
  access.codeHint    = plain.slice(-2);
  access.codeSetAt   = new Date();
  access.revokedAt   = null;
  access.failedTries = 0;
  access.lockedUntil = null;
  // A new code is a new credential. Sessions opened with the old one end here,
  // for the same reason a password change ends staff sessions: if the slip was
  // re-issued because it went astray, whoever holds the old one must not keep
  // a ninety-day session out of it.
  access.sessions    = [];
  await access.save();

  return { code, accessId: String(access._id), hint: access.codeHint };
};

/** Change which children an access covers, leaving the code alone. */
const setChildren = async ({ schoolId, accessId, studentIds }) => {
  const access = await GuardianAccess.findOne({ _id: accessId, schoolId, deletedAt: null });
  if (!access) {
    const err = new Error("Guardian access not found");
    err.status = 404;
    throw err;
  }

  const ids = [...new Set((studentIds ?? []).map(String))];
  if (!ids.length) {
    const err = new Error("Choose at least one child");
    err.status = 400;
    err.code   = "NO_STUDENTS";
    throw err;
  }
  await assertOwnStudents(schoolId, ids);

  access.studentIds = ids;
  await access.save();
  return access;
};

const revokeAccess = async ({ schoolId, accessId }) => {
  const access = await GuardianAccess.findOne({ _id: accessId, schoolId, deletedAt: null });
  if (!access) {
    const err = new Error("Guardian access not found");
    err.status = 404;
    throw err;
  }

  // The hash is cleared as well as the timestamp set. Leaving it would make
  // revocation depend on one `if` staying correct for ever; with no hash there
  // is nothing left to compare against.
  access.codeHash    = null;
  access.codeHint    = null;
  access.revokedAt   = new Date();
  access.failedTries = 0;
  access.lockedUntil = null;
  // The sessions are deliberately LEFT on the row. They are dead - portalAuth
  // and refresh both refuse a row with no hash on every call - and leaving
  // them is what lets a refresh answer ACCESS_REVOKED rather than
  // SESSION_EXPIRED, so the phone can say "ask the school office" instead of
  // "sign in again" to a parent who cannot. A re-issue clears them.
  await access.save();

  return { revokedAt: access.revokedAt };
};

// ─────────────────────────────────────────────────────────────────────────────
// SIGN IN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exchange any one of the guardian's children's admission numbers plus the code
 * for a token covering all of them.
 *
 * Failures are deliberately indistinguishable: a wrong admission number, a
 * wrong code, and a child with no access issued all answer identically. Saying
 * "no such student" would turn the login form into a roll-call of who attends
 * the school.
 */
const login = async ({ schoolId, admissionNo, code }) => {
  const deny = () => {
    const err = new Error("That admission number and code do not match");
    err.status = 401;
    err.code   = "INVALID_CREDENTIALS";
    return err;
  };

  const enrollmentNo = String(admissionNo ?? "").trim();
  const plain = normalise(code);
  if (!enrollmentNo || !plain) throw deny();

  const student = await Student.findOne({
    schoolId,
    enrollmentNo: { $regex: `^${escapeRegex(enrollmentNo)}$`, $options: "i" },
    deletedAt: null,
  }).select("_id").lean();

  if (!student) throw deny();

  // A child can sit on more than one access — separated parents each holding
  // their own code is ordinary. Every candidate is checked, so whichever code
  // was typed is the one that matches.
  const candidates = await GuardianAccess.find({
    schoolId,
    studentIds: String(student._id),
    deletedAt: null,
    codeHash: { $ne: null },
  });

  if (!candidates.length) throw deny();

  const now = new Date();
  const open = candidates.filter((a) => !(a.lockedUntil && a.lockedUntil > now));

  if (!open.length) {
    const err = new Error("Too many attempts. Try again shortly.");
    err.status = 429;
    err.code   = "LOCKED";
    err.retryAfter = Math.ceil(
      (Math.min(...candidates.map((a) => a.lockedUntil.getTime())) - Date.now()) / 1000
    );
    throw err;
  }

  let matched = null;
  for (const access of open) {
    if (await bcrypt.compare(plain, access.codeHash)) { matched = access; break; }
  }

  if (!matched) {
    // Only the accesses actually tried take the strike; a locked one is not
    // punished again for an attempt it did not participate in.
    for (const access of open) {
      access.failedTries = (access.failedTries ?? 0) + 1;
      if (access.failedTries >= MAX_TRIES) {
        access.lockedUntil = new Date(Date.now() + LOCK_MS);
        access.failedTries = 0;
      }
      await access.save();
    }
    throw deny();
  }

  matched.failedTries = 0;
  matched.lockedUntil = null;
  matched.lastSeenAt  = new Date();
  const { refreshToken, session } = startSession(matched);
  await matched.save();

  return {
    ...tokenResponse(matched, session, refreshToken),
    children: await childrenOf(schoolId, matched.studentIds),
  };
};

/**
 * Exchange a session's refresh token for a fresh access token.
 *
 * Public - it is called precisely when the access token is no longer any good.
 * Every refusal is a 401, and the client treats a 401 here as final: the
 * session is over, whatever the reason. The reasons are still told apart in
 * `code`, because "your session ended" and "the school withdrew this code"
 * call for different sentences on the screen.
 *
 * The token is not rotated. A rotated token that reaches the server and not
 * the phone - a timeout after the write, a battery dying mid-response - signs
 * the parent out, which is the failure this whole arrangement exists to
 * remove. The cost is that a copied token stays good until sign-out or
 * revocation, and both of those work.
 */
const refresh = async ({ refreshToken }) => {
  const ended = (code, message) => {
    const err = new Error(message);
    err.status = 401;
    err.code   = code;
    return err;
  };
  const expired = () => ended("SESSION_EXPIRED", "Your session has expired. Sign in again.");

  const token = String(refreshToken ?? "").trim();
  if (!token) throw expired();

  const hash   = hashToken(token);
  const access = await GuardianAccess.findOne({
    "sessions.tokenHash": hash, deletedAt: null,
  }).lean();
  if (!access) throw expired();

  const session = (access.sessions ?? []).find((s) => s.tokenHash === hash);
  if (!session) throw expired();

  // The same rule portalAuth applies on every request: the code is the
  // authorisation, and a session is only as alive as the code that opened it.
  if (!access.codeHash || access.revokedAt) {
    throw ended("ACCESS_REVOKED", "This access code is no longer valid. Ask the school office.");
  }

  const now = new Date();
  if (!session.expiresAt || session.expiresAt <= now) {
    await GuardianAccess.updateOne(
      { _id: access._id }, { $pull: { sessions: { _id: session._id } } }
    );
    throw expired();
  }

  // lastSeenAt meant "last signed in", which with a ninety-day session would
  // freeze on the day the code was first used. The office reads it as "is this
  // code in use", so it now moves with the session.
  await GuardianAccess.updateOne(
    { _id: access._id, "sessions._id": session._id },
    { $set: { "sessions.$.lastUsedAt": now, lastSeenAt: now } }
  );

  return tokenResponse(access, session, null);
};

/**
 * End one device's session. Idempotent and always quiet: the phone has already
 * forgotten its tokens by the time this is called, and an unknown token means
 * there is nothing left to end.
 */
const logout = async ({ refreshToken }) => {
  const token = String(refreshToken ?? "").trim();
  if (!token) return { ended: false };

  const hash   = hashToken(token);
  const result = await GuardianAccess.updateOne(
    { "sessions.tokenHash": hash },
    { $pull: { sessions: { tokenHash: hash } } }
  );
  return { ended: (result.modifiedCount ?? 0) > 0 };
};

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express middleware for portal-only routes.
 *
 * Verifies the audience explicitly — `jwt.verify` does not check `aud` unless
 * asked, so omitting it would let a staff token through.
 *
 * Also resolves WHICH child is being asked about: `?studentId=` when given,
 * otherwise the first. An id not on the access is REFUSED rather than ignored,
 * because ignoring it would quietly answer about a different child than the one
 * the caller named.
 */
const portalAuth = async (req, res, next) => {
  const header = req.headers.authorization ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  const unauthorised = (code, message) =>
    res.status(401).json({ success: false, code, message });

  if (!token) return unauthorised("NO_TOKEN", "Sign in to view this page");

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { audience: "portal", algorithms: ["HS256"] });
  } catch (err) {
    return unauthorised(
      err.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
      err.name === "TokenExpiredError"
        ? "Your session has expired. Sign in again."
        : "Sign in to view this page"
    );
  }

  if (!decoded.accessId || !decoded.schoolId) {
    return unauthorised("INVALID_TOKEN", "Sign in to view this page");
  }

  // Re-read every request: a code revoked five minutes ago must stop working
  // now, not in twelve hours when the token happens to expire.
  const access = await GuardianAccess.findOne({
    _id: decoded.accessId, schoolId: decoded.schoolId, deletedAt: null,
  }).lean();

  if (!access || !access.codeHash || access.revokedAt) {
    return unauthorised(
      "ACCESS_REVOKED",
      "This access code is no longer valid. Ask the school office."
    );
  }

  const allowed = (access.studentIds ?? []).map(String);
  const asked   = req.query.studentId ? String(req.query.studentId) : null;

  if (asked && !allowed.includes(asked)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const studentId = asked ?? allowed[0];
  if (!studentId) {
    return unauthorised("NO_CHILDREN", "This code is not linked to any child.");
  }

  const student = await Student.findOne({
    _id: studentId, schoolId: decoded.schoolId, deletedAt: null,
  }).select("studentName name firstName lastName enrollmentNo classId status").lean();

  if (!student) return res.status(404).json({ success: false, message: "Not found" });

  req.portal = {
    accessId:   String(access._id),
    // Read here rather than re-queried by the notices route: this middleware
    // already has the row, and it re-reads it on every request anyway so a
    // revoked code stops working at once.
    noticesSeenAt: access.noticesSeenAt ?? null,
    schoolId:   decoded.schoolId,
    studentIds: allowed,
    studentId:  String(student._id),
    student,
  };

  return next();
};

module.exports = {
  generateCode, normalise,
  issueAccess, setChildren, revokeAccess,
  login, refresh, logout, childrenOf, portalAuth,
  signAccessToken, hashToken,
  MAX_TRIES, ACCESS_TOKEN_MINUTES, SESSION_DAYS, MAX_SESSIONS,
};
