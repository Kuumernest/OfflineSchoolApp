// backend/src/services/teacherProfile.service.js
"use strict";

/**
 * A teacher's own profile — what they fill in on the phone's profile screen
 * (mobile/app/teacher/profile/setup.js).
 *
 * It used to be stored nowhere: PUT /teacher/profile kept name and email and
 * answered 200 for the other twenty-one fields, so the profile lived only in
 * one phone's SQLite and looked "lost" whenever the phone read the server's
 * copy. It now lives on the teacher's User record, in `teacherProfile`.
 *
 * The rules, shared by the route and scripts/check-teacher-profile.js:
 *   - only the fields below are accepted; anything else is ignored;
 *   - a field is written only when the request carries it with a value — an
 *     empty string does NOT clear what is stored (an older build, or a form
 *     opened before the profile loaded, posts every field, often blank);
 *     a field is cleared only when it is named in `clearFields`;
 *   - `profileCompleted: true` marks the profile complete; it is never unset
 *     by an omitted or empty value.
 *
 * The Staff ID the phone used to ask for is not here: the school's staff
 * number is users.staffNo, issued by the server (staffNumber.service.js).
 */

/** Field → maximum length. All are free text, kept as typed (trimmed). */
const TEACHER_PROFILE_FIELDS = Object.freeze({
  firstName:         60,
  lastName:          60,
  gender:            20,
  dateOfBirth:       20,
  nationalId:        40,
  qualification:     80,
  employmentType:    30,
  joinDate:          20,
  yearsOfExperience: 10,
  previousSchool:    120,
  phone:             30,
  alternatePhone:    30,
  address:           200,
  city:              80,
  state:             80,
  emergencyName:     100,
  emergencyPhone:    30,
  emergencyRelation: 40,
  bloodGroup:        10,
  medicalConditions: 1000,
  bio:               1000,
});

const FIELD_NAMES = Object.keys(TEACHER_PROFILE_FIELDS);

/**
 * The `$set` / `$unset` for a profile save. Pure: no database access.
 * @returns {{ set: object, unset: object, touched: boolean }}
 */
function buildProfileUpdate(body = {}, now = new Date()) {
  const set = {};
  const unset = {};
  const clear = new Set(Array.isArray(body.clearFields) ? body.clearFields : []);

  for (const field of FIELD_NAMES) {
    if (clear.has(field)) { unset[`teacherProfile.${field}`] = ""; continue; }
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const raw = body[field];
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim().slice(0, TEACHER_PROFILE_FIELDS[field]);
    if (!value) continue;                       // blank never wipes a stored value
    set[`teacherProfile.${field}`] = value;
  }
  if (body.profileCompleted === true) set["teacherProfile.completed"] = true;

  const touched = Object.keys(set).length > 0 || Object.keys(unset).length > 0;
  if (touched) set["teacherProfile.updatedAt"] = now;
  return { set, unset, touched };
}

/**
 * What GET/PUT /teacher/profile return under `data`: the account fields and
 * the profile flattened, as the phone's form reads them.
 */
function profileResponse(user) {
  if (!user) return null;
  const p = user.teacherProfile || {};
  const out = {
    id:       String(user._id),
    _id:      String(user._id),
    name:     user.name ?? "",
    email:    user.email ?? null,
    staffNo:  user.staffNo ?? null,
    role:     user.role,
    schoolId: user.schoolId ?? null,
  };
  for (const field of FIELD_NAMES) out[field] = p[field] ?? null;
  out.profileCompleted = p.completed === true;
  out.profileUpdatedAt = p.updatedAt ?? null;
  return out;
}

module.exports = { TEACHER_PROFILE_FIELDS, FIELD_NAMES, buildProfileUpdate, profileResponse };
