// backend/src/services/audit.service.js
"use strict";

const AuditLog = require("../db/models/AuditLog");

/**
 * The platform audit trail — see db/models/AuditLog.js for what it is for.
 *
 * recordAudit never throws. An audit row that fails to write is reported on
 * the console and the action it describes goes ahead: the alternative is a
 * school that cannot be switched off because the log collection is full, and
 * a platform administrator locked out of the one action they were called in
 * to take. The trade is stated here so nobody later "fixes" it.
 */

const clip = (value, max) => {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * @param {import("express").Request} req   the request the actor made
 * @param {object} entry
 * @param {string} entry.action             one of AuditLog.ACTIONS
 * @param {string|null} [entry.schoolId]    the school acted upon
 * @param {string|null} [entry.schoolName]
 * @param {{type:string,id?:string,label?:string}|null} [entry.resource]
 * @param {object|null} [entry.before]      changed fields only
 * @param {object|null} [entry.after]
 * @param {string|null} [entry.reason]
 */
const recordAudit = async (req, {
  action, schoolId = null, schoolName = null, resource = null,
  before = null, after = null, reason = null,
}) => {
  try {
    const user = req?.user ?? {};
    return await AuditLog.create({
      action,
      actorId:   user._id != null ? String(user._id) : null,
      actorName: user.name ?? null,
      actorRole: user.role ?? null,
      schoolId:   schoolId != null ? String(schoolId) : null,
      schoolName: schoolName ?? null,
      resourceType:  resource?.type ?? null,
      resourceId:    resource?.id != null ? String(resource.id) : null,
      resourceLabel: resource?.label ?? null,
      before, after,
      reason:    clip(reason, 500),
      ip:        req?.ip ?? null,
      userAgent: clip(req?.headers?.["user-agent"], 200),
    });
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err.message);
    return null;
  }
};

/**
 * The fields in `keys` whose value differs between two documents, as the
 * before/after pair an audit row stores. Compared by JSON so a Date and its
 * string, or two equal arrays, do not read as a change.
 */
const diff = (before, after, keys) => {
  const b = {}, a = {};
  for (const k of keys) {
    const x = before?.[k] ?? null;
    const y = after?.[k]  ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) { b[k] = x; a[k] = y; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
};

/**
 * Page through the trail. Every filter optional; newest first.
 */
const listAudit = async ({
  schoolId, action, actorId, from, to, page = 1, limit = 50,
} = {}) => {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));

  const match = {};
  if (schoolId) match.schoolId = String(schoolId);
  if (actorId)  match.actorId  = String(actorId);
  if (action && AuditLog.ACTIONS.includes(String(action))) match.action = String(action);
  if (from || to) {
    match.at = {};
    if (from) { const d = new Date(from); if (!Number.isNaN(d.getTime())) match.at.$gte = d; }
    if (to)   { const d = new Date(to);   if (!Number.isNaN(d.getTime())) match.at.$lte = d; }
    if (!Object.keys(match.at).length) delete match.at;
  }

  const [entries, total] = await Promise.all([
    AuditLog.find(match).sort({ at: -1 }).skip((p - 1) * l).limit(l).lean(),
    AuditLog.countDocuments(match),
  ]);

  return { entries, total, page: p, pages: Math.ceil(total / l) || 1, limit: l };
};

module.exports = { recordAudit, diff, listAudit, ACTIONS: AuditLog.ACTIONS };
