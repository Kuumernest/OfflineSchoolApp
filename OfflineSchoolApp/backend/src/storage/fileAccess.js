// backend/src/storage/fileAccess.js
"use strict";

/**
 * Who may read a stored file — one rule for /uploads/… and /files/:id.
 *
 *   logos/          anyone: the public school list shows them anyway
 *   everything else (pupil photos, message attachments, teacher content):
 *                   - a signed link for that very file (utils/mediaSignature.js:
 *                     message attachments, and photos on a printed report
 *                     card, which opens in a window that has no login), or
 *                   - a signed-in user of the file's school, or a Super Admin
 *
 * (applications/ never gets here: server.js closes that prefix, and the
 * documents are reached through their own authorised route.)
 *
 * The file's school is the one GridFS keeps with it (fileStore put(…,
 * { schoolId })). A file written before that — on a disk or in a bucket —
 * has none; a photo's school is then read from the pupil its name starts
 * with, and a file whose school cannot be told is open to any signed-in user.
 *
 * A file of another school answers 404, as a missing file would: "forbidden"
 * would confirm it exists.
 */

const mongoose = require("mongoose");

const mediaSignature   = require("../utils/mediaSignature");
const { PUBLIC_DIRS }  = require("./fileStore");
const { ROLES }        = require("../config/roles");

const dirOf = (key) => String(key).split("/")[0];

const isPublicKey = (key) => PUBLIC_DIRS.includes(dirOf(key));

/** The school a file belongs to, as a string, or null when it cannot be told. */
async function schoolOfFile(key, file) {
  if (file?.schoolId) return String(file.schoolId);
  const m = /^photos\/([0-9a-f]{24})-/i.exec(String(key));
  if (m) {
    const s = await mongoose.connection.db?.collection("students")
      .findOne({ _id: new mongoose.Types.ObjectId(m[1]) }, { projection: { schoolId: 1 } });
    if (s?.schoolId) return String(s.schoolId);
  }
  return null;
}

/** The school a signed-in user acts for: their own, or their pupil record's. */
async function schoolOfUser(user) {
  if (user?.schoolId) return String(user.schoolId);
  if (user?.role === ROLES.STUDENT) {
    const s = await mongoose.connection.db?.collection("students")
      .findOne({ userId: { $in: [user._id, String(user._id)] } }, { projection: { schoolId: 1 } });
    if (s?.schoolId) return String(s.schoolId);
  }
  return null;
}

/**
 * May this request read the file? Resolves true, or false once it has
 * answered: 401 for no or a bad login (from `authenticate` itself), 404 for a
 * file of another school.
 *
 * @param {Function} authenticate  middleware/auth.js authenticate
 */
const makeFileGate = (authenticate) => async (req, res, key, file) => {
  if (isPublicKey(key)) return true;

  const sig = req.query?.sig;
  if (sig && mediaSignature.verifyMediaSignature(key, String(sig))) return true;

  let signedIn = false;
  await authenticate(req, res, () => { signedIn = true; });
  if (!signedIn) return false;

  if (await userMayRead(req.user, key, file)) return true;
  res.status(404).json({ error: "File not found" });
  return false;
};

/** A signed-in user's own right to a file: Super Admin, or the file's school. */
async function userMayRead(user, key, file) {
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN || isPublicKey(key)) return true;
  const [fileSchool, userSchool] = await Promise.all([schoolOfFile(key, file), schoolOfUser(user)]);
  return !fileSchool || (!!userSchool && userSchool === fileSchool);
}

/** How long a link from GET /api/files/signed-link works. */
const SIGNED_LINK_HOURS = 1;

/**
 * GET /api/files/signed-link?url=/uploads/… (behind authenticate) — a link
 * to a file the caller may read that works without a login for an hour: for
 * handing a document to the phone's browser or another app, which cannot
 * send the token.
 */
const signedLink = async (req, res, next) => {
  try {
    const { keyFromUrl, getStore } = require("./fileStore");
    const key = keyFromUrl(String(req.query?.url ?? ""));
    if (!key || key.startsWith("applications/")) return res.status(400).json({ success: false, message: "Not a stored file" });
    const file = await getStore().stat(key);
    if (!file || !(await userMayRead(req.user, key, file))) {
      return res.status(404).json({ success: false, message: "File not found" });
    }
    const signed = mediaSignature.signMediaPath(key, { hours: SIGNED_LINK_HOURS });
    const url = `/uploads/${key.split("/").map(encodeURIComponent).join("/")}?${signed.split("?")[1]}`;
    return res.json({ success: true, url, expiresInSeconds: SIGNED_LINK_HOURS * 3600 });
  } catch (err) {
    return next(err);
  }
};

module.exports = { makeFileGate, signedLink, userMayRead, isPublicKey, schoolOfFile, schoolOfUser };
