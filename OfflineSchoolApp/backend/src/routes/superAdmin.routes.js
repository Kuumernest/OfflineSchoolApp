// backend/src/routes/superAdmin.routes.js
"use strict";

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const School   = require("../db/models/School");
const Student  = require("../db/models/Student");
const User     = require("../db/models/User");

const { requirePermission } = require("../../middleware/permissions");
const { ROLES }             = require("../config/roles");
const { isValidEmail }      = require("../utils/email");
const { invalidateSchool, looksLikeSchoolId } = require("../utils/schoolContext");
const { recordAudit, diff: auditDiff, listAudit, ACTIONS } =
  require("../services/audit.service");
const { parseFilters, computePlatformStats, availableFilters } =
  require("../services/platformStats.service");

/**
 * The platform: what sits ABOVE a school.
 *
 * Everything a super_admin does INSIDE a school goes through the ordinary
 * routers — /api/admin/students?schoolId=…, /api/admin/settings/admins with a
 * schoolId in the body — because utils/tenant.js already lets that role name
 * a school, middleware/auth.js now checks that the school exists, and the
 * permission registry hands the role every school capability. Nothing about
 * running a school is duplicated here.
 *
 * What this router adds is the part no school may do about itself or its
 * neighbours: bring a school into existence, describe it, switch it on or
 * off, look across all of them, and read the record of having done so. Each
 * route carries one of the four `platform.*` capabilities, which only
 * super_admin holds and no school can grant — so a school administrator gets
 * the same 403, naming the capability, that any other missing capability
 * produces.
 *
 * Mounted at /api/super-admin behind authenticate.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const sendSuccess = (res, data, status = 200) =>
  res.status(status).json({ success: true, ...data });

const sendError = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const canView   = requirePermission("platform.schools");
const canManage = requirePermission("platform.manageSchools");
const canReport = requirePermission("platform.dashboard");
const canAudit  = requirePermission("platform.audit");

// ─────────────────────────────────────────────────────────────────────────────
// SHARED
// ─────────────────────────────────────────────────────────────────────────────

/** The fields a platform administrator describes a school by. */
const IDENTITY_FIELDS = [
  "name", "code", "email", "phone", "address", "city", "state", "country",
  "website", "principalName", "verified",
];

const SCHOOL_SELECT =
  "_id name code email phone address city state country website principalName " +
  "isActive verified applicationsOpen createdAt updatedAt " +
  "settings.academicYear settings.currentTerm settings.currency";

/** A school by id, not deleted, or null. A malformed id is simply "no school". */
const findSchool = async (id) => {
  if (!looksLikeSchoolId(id)) return null;
  return School.findOne({ _id: id, ...School.notDeletedClause() }).select(SCHOOL_SELECT).lean();
};

/** Approved pupils and active staff, per school, for a set of school ids. */
const countsFor = async (ids) => {
  if (!ids.length) return new Map();
  const [pupils, staff] = await Promise.all([
    Student.aggregate([
      { $match: { schoolId: { $in: ids }, deletedAt: null, status: "approved" } },
      { $group: { _id: "$schoolId", n: { $sum: 1 } } },
    ]),
    User.aggregate([
      { $match: { schoolId: { $in: ids }, isActive: true,
                  role: { $in: [ROLES.TEACHER, ROLES.SCHOOL_ADMIN, ROLES.BURSAR] } } },
      { $group: { _id: { schoolId: "$schoolId", role: "$role" }, n: { $sum: 1 } } },
    ]),
  ]);
  const out = new Map(ids.map((id) => [id, { students: 0, teachers: 0, admins: 0, bursars: 0 }]));
  for (const p of pupils) if (out.has(String(p._id))) out.get(String(p._id)).students = p.n;
  for (const s of staff) {
    const row = out.get(String(s._id.schoolId));
    if (!row) continue;
    if (s._id.role === ROLES.TEACHER)      row.teachers = s.n;
    if (s._id.role === ROLES.SCHOOL_ADMIN) row.admins   = s.n;
    if (s._id.role === ROLES.BURSAR)       row.bursars  = s.n;
  }
  return out;
};

const shape = (school, counts) => ({
  ...school,
  _id:      String(school._id),
  isActive: school.isActive !== false,
  counts:   counts ?? { students: 0, teachers: 0, admins: 0, bursars: 0 },
});

/**
 * Pick the identity fields off a body, validated. Returns { fields, error }.
 * Unknown keys are ignored rather than refused — a client sending the whole
 * form is not doing anything wrong, it is simply not this route's business.
 */
const pickIdentity = (body, { requireName }) => {
  const fields = {};
  for (const key of IDENTITY_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (key === "verified") { fields.verified = Boolean(raw); continue; }
    const value = raw == null ? null : String(raw).trim();
    if (key === "name") {
      if (!value || value.length < 2 || value.length > 200) {
        return { error: "name must be between 2 and 200 characters" };
      }
    } else if (key === "email" && value && !isValidEmail(value)) {
      return { error: "A valid email is required" };
    } else if (key === "code" && value && !/^[A-Za-z0-9-]{1,10}$/.test(value)) {
      return { error: "code may only contain letters, numbers and hyphens (max 10)" };
    }
    fields[key] = key === "email" && value ? value.toLowerCase() : (value || null);
  }
  if (requireName && !fields.name) return { error: "name is required" };
  return { fields };
};

/** Mongo's duplicate-key error, as the 409 it is. */
const duplicateOf = (err) => {
  if (err?.code !== 11000) return null;
  const key = Object.keys(err.keyPattern ?? err.keyValue ?? {})[0] ?? "field";
  return `A school with this ${key} already exists`;
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /schools?search=&status=all|active|inactive&page=&limit=
 */
router.get("/schools", canView, asyncHandler(async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page ?? "1", 10) || 1);
  const limit  = Math.max(1, Math.min(100, parseInt(req.query.limit ?? "25", 10) || 25));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "all");

  const and = [School.notDeletedClause()];
  if (status === "active")   and.push({ isActive: { $ne: false } });
  if (status === "inactive") and.push({ isActive: false });
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    and.push({ $or: [{ name: rx }, { code: rx }, { city: rx }, { email: rx }] });
  }
  const query = { $and: and };

  const [schools, total] = await Promise.all([
    School.find(query).select(SCHOOL_SELECT).sort({ name: 1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    School.countDocuments(query),
  ]);

  const counts = await countsFor(schools.map((s) => String(s._id)));

  return sendSuccess(res, {
    schools: schools.map((s) => shape(s, counts.get(String(s._id)))),
    total, page, limit, pages: Math.ceil(total / limit) || 1,
  });
}));

/**
 * POST /schools — bring a school into existence.
 *
 * Its first administrator is appointed afterwards through the existing
 * POST /api/admin/settings/admins with this school's id, which already knows
 * how to claim, restore and welcome a staff account; there is no second copy
 * of that here.
 */
router.post("/schools", canManage, asyncHandler(async (req, res) => {
  const { fields, error } = pickIdentity(req.body ?? {}, { requireName: true });
  if (error) return sendError(res, 400, error);

  const settings = {};
  const s = req.body?.settings ?? {};
  if (s.academicYear) settings.academicYear = String(s.academicYear).trim();
  if (s.currentTerm)  settings.currentTerm  = String(s.currentTerm).trim();
  if (s.currency)     settings.currency     = String(s.currency).trim();
  if (s.timezone)     settings.timezone     = String(s.timezone).trim();

  let school;
  try {
    school = await School.create({
      ...fields,
      isActive: true,
      ...(Object.keys(settings).length ? { settings } : {}),
    });
  } catch (err) {
    const dup = duplicateOf(err);
    if (dup) return sendError(res, 409, dup);
    if (err?.name === "ValidationError") return sendError(res, 400, err.message);
    throw err;
  }

  const id = String(school._id);
  await recordAudit(req, {
    action: "school.created", schoolId: id, schoolName: school.name,
    resource: { type: "school", id, label: school.name },
    after: { ...fields, settings: Object.keys(settings).length ? settings : undefined },
  });

  return sendSuccess(res, { school: shape(await findSchool(id), null) }, 201);
}));

/**
 * GET /schools/:schoolId — one school, its staff, and what was last done to it.
 */
router.get("/schools/:schoolId", canView, asyncHandler(async (req, res) => {
  const school = await findSchool(req.params.schoolId);
  if (!school) return sendError(res, 404, "School not found");
  const id = String(school._id);

  const [counts, admins, recent] = await Promise.all([
    countsFor([id]),
    User.find({ schoolId: id, role: { $in: [ROLES.SCHOOL_ADMIN, ROLES.BURSAR] }, isActive: true })
      .select("_id name email role isActive mustResetPassword createdAt")
      .sort({ role: 1, name: 1 }).lean(),
    listAudit({ schoolId: id, limit: 10 }),
  ]);

  return sendSuccess(res, {
    school: shape(school, counts.get(id)),
    admins,
    recentAudit: recent.entries,
  });
}));

/**
 * PATCH /schools/:schoolId — change how the platform describes a school.
 *
 * Identity only. The school's own profile — motto, logo, hours, the fields
 * its administrator owns — stays on PUT /api/admin/school-info, which this
 * role reaches with a schoolId like anyone else's admin does.
 */
router.patch("/schools/:schoolId", canManage, asyncHandler(async (req, res) => {
  const before = await findSchool(req.params.schoolId);
  if (!before) return sendError(res, 404, "School not found");
  const id = String(before._id);

  const { fields, error } = pickIdentity(req.body ?? {}, { requireName: false });
  if (error) return sendError(res, 400, error);
  if (!Object.keys(fields).length) return sendError(res, 400, "Nothing to change");

  let after;
  try {
    after = await School.findByIdAndUpdate(
      id, { $set: fields }, { returnDocument: "after", runValidators: true }
    ).select(SCHOOL_SELECT).lean();
  } catch (err) {
    const dup = duplicateOf(err);
    if (dup) return sendError(res, 409, dup);
    if (err?.name === "ValidationError") return sendError(res, 400, err.message);
    throw err;
  }
  invalidateSchool(id);

  const d = auditDiff(before, after, Object.keys(fields));
  if (d.changed.length) {
    await recordAudit(req, {
      action: "school.updated", schoolId: id, schoolName: after.name,
      resource: { type: "school", id, label: after.name },
      before: d.before, after: d.after,
    });
  }

  const counts = await countsFor([id]);
  return sendSuccess(res, { school: shape(after, counts.get(id)), changed: d.changed });
}));

/**
 * POST /schools/:schoolId/activate | /deactivate
 *
 * Deactivation is the platform's "off switch" and nothing more destructive:
 * the school's data stays, its staff can still sign in (that is the existing
 * rule, and changing it is a decision for the school, not a side effect of
 * this route), and it can be switched back on. There is no delete here on
 * purpose.
 */
const setActive = (isActive, action) => asyncHandler(async (req, res) => {
  const before = await findSchool(req.params.schoolId);
  if (!before) return sendError(res, 404, "School not found");
  const id = String(before._id);

  const reason = req.body?.reason ? String(req.body.reason).trim() : null;
  if (!isActive && !reason) return sendError(res, 400, "A reason is required to deactivate a school");

  const wasActive = before.isActive !== false;
  if (wasActive === isActive) {
    return sendSuccess(res, { school: shape(before, (await countsFor([id])).get(id)), changed: false });
  }

  const after = await School.findByIdAndUpdate(
    id, { $set: { isActive } }, { returnDocument: "after" }
  ).select(SCHOOL_SELECT).lean();
  invalidateSchool(id);

  await recordAudit(req, {
    action, schoolId: id, schoolName: after.name,
    resource: { type: "school", id, label: after.name },
    before: { isActive: wasActive }, after: { isActive }, reason,
  });

  return sendSuccess(res, { school: shape(after, (await countsFor([id])).get(id)), changed: true });
});

router.post("/schools/:schoolId/activate",   canManage, setActive(true,  "school.activated"));
router.post("/schools/:schoolId/deactivate", canManage, setActive(false, "school.deactivated"));

/**
 * POST /schools/:schoolId/enter — step into a school.
 *
 * The context itself is per request: every call a super_admin then makes
 * names the school in `schoolId`, and nothing on the server remembers which
 * school they are "in" — so it cannot leak into the next request, or into
 * another tab. What this route adds is the record that it happened, and the
 * school's current state for the client to display while it is inside.
 */
router.post("/schools/:schoolId/enter", canView, asyncHandler(async (req, res) => {
  const school = await findSchool(req.params.schoolId);
  if (!school) return sendError(res, 404, "School not found");
  const id = String(school._id);

  await recordAudit(req, {
    action: "school.entered", schoolId: id, schoolName: school.name,
    resource: { type: "school", id, label: school.name },
  });

  return sendSuccess(res, {
    school: {
      _id:          id,
      name:         school.name,
      code:         school.code ?? null,
      isActive:     school.isActive !== false,
      academicYear: school.settings?.academicYear ?? null,
      currentTerm:  school.settings?.currentTerm  ?? null,
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ACROSS SCHOOLS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /dashboard — the totals, plus a row per school. */
router.get("/dashboard", canReport, asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  if (filters.schoolId && !(await findSchool(filters.schoolId))) {
    return sendError(res, 404, "School not found");
  }
  const stats = await computePlatformStats(filters);
  return sendSuccess(res, stats);
}));

/** GET /performance — the same figures, meant to be read as a comparison. */
router.get("/performance", canReport, asyncHandler(async (req, res) => {
  const filters = parseFilters(req.query);
  if (filters.schoolId && !(await findSchool(filters.schoolId))) {
    return sendError(res, 404, "School not found");
  }
  const { schools, totals } = await computePlatformStats(filters);
  return sendSuccess(res, { filters, totals, schools });
}));

/** GET /filters — the years and schools the filter controls can offer. */
router.get("/filters", canReport, asyncHandler(async (_req, res) => {
  return sendSuccess(res, await availableFilters());
}));

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORD
// ─────────────────────────────────────────────────────────────────────────────

/** GET /audit?schoolId=&action=&actorId=&from=&to=&page=&limit= */
router.get("/audit", canAudit, asyncHandler(async (req, res) => {
  const result = await listAudit({
    schoolId: req.query.schoolId, action: req.query.action, actorId: req.query.actorId,
    from: req.query.from, to: req.query.to, page: req.query.page, limit: req.query.limit,
  });
  return sendSuccess(res, { ...result, actions: ACTIONS });
}));

// A malformed ObjectId anywhere above is "no such school", not a 500.
router.use((err, _req, res, next) => {
  if (err instanceof mongoose.Error.CastError) {
    return sendError(res, 404, "School not found");
  }
  return next(err);
});

module.exports = router;
