// backend/src/services/resultAudit.service.js
"use strict";

const { v4: uuidv4 } = require("uuid");

const ResultChangeLog = require("../db/models/ResultChangeLog");
const ResultSummary   = require("../db/models/ResultSummary");

/**
 * The lock guard and the audit writer, in one place.
 *
 * `isLocked` and `isPublished` existed on ResultSummary but nothing enforced
 * them: POST /exams/:id/scores/bulk and POST /results/score both wrote marks
 * without ever looking. A published report card could be changed underneath a
 * parent who had already seen it, leaving no trace.
 *
 * Every write path now calls guardResultWrite() first. Keeping it here rather
 * than repeating the check per route is deliberate — the attendance routes in
 * this codebase showed what happens when a rule has to be remembered at each
 * call site.
 */

// ─────────────────────────────────────────────────────────────────────────────
// LOCK STATE
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ROLES = new Set(["admin", "school_admin", "super_admin"]);

const isAdmin = (role) => ADMIN_ROLES.has(String(role || ""));

/**
 * What protects this result right now.
 *
 * Two separate protections, deliberately not collapsed into one boolean:
 *   locked    — an admin has frozen the exam; nobody edits without a reason
 *   published — parents can already see it; changing it silently is worse than
 *               refusing, even though the exam is not formally locked
 *
 * @param {object}  q
 * @param {string}  q.examId
 * @param {string}  q.schoolId
 * @param {string} [q.studentId]  omit to ask about the whole exam
 */
const getProtection = async ({ examId, schoolId, studentId }) => {
  const filter = { examId, schoolId, deletedAt: null };
  if (studentId) filter.studentId = studentId;

  // One row is enough to know the exam is protected; only ask for the flags.
  const [locked, published] = await Promise.all([
    ResultSummary.exists({ ...filter, isLocked:    true }),
    ResultSummary.exists({ ...filter, isPublished: true }),
  ]);

  return {
    isLocked:    Boolean(locked),
    isPublished: Boolean(published),
    isProtected: Boolean(locked || published),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GUARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a write may proceed, and answer the request itself when it
 * may not.
 *
 * Returns `null` when the caller should stop — the response has already been
 * sent. Otherwise returns the audit context to pass into logResultChange().
 *
 *   const audit = await guardResultWrite(req, res, { examId, schoolId });
 *   if (!audit) return;              // 423 already sent
 *
 * 423 Locked is the correct status: the resource exists and the request is
 * well-formed, but the resource's own state forbids the method. A 400 would
 * tell the client it sent something wrong, which it did not.
 */
const guardResultWrite = async (req, res, {
  examId,
  schoolId,
  studentId = null,
  subjectId = null,
}) => {
  const role   = req.user?.role;
  const reason = (req.body?.changeReason || req.body?.reason || "").trim();

  const protection = await getProtection({ examId, schoolId, studentId });

  const context = {
    examId,
    schoolId,
    studentId,
    subjectId,
    reason:     reason || null,
    isOverride: false,
    batchId:    uuidv4(),
    actor: {
      id:   req.user?._id ? String(req.user._id) : null,
      name: req.user?.name || null,
      role: role || null,
    },
  };

  if (!protection.isProtected) return context;

  // Protected from here down.
  if (!isAdmin(role)) {
    res.status(423).json({
      success: false,
      code:    protection.isLocked ? "RESULTS_LOCKED" : "RESULTS_PUBLISHED",
      message: protection.isLocked
        ? "These results are locked. Ask an administrator to unlock them before editing."
        : "These results are already published. Ask an administrator to make a correction.",
    });
    return null;
  }

  if (!reason) {
    res.status(423).json({
      success: false,
      code:    "REASON_REQUIRED",
      message: protection.isLocked
        ? "These results are locked. Send a `changeReason` to record why you are overriding the lock."
        : "These results are published. Send a `changeReason` to record why you are correcting them.",
    });
    return null;
  }

  return { ...context, isOverride: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT WRITER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append one or more rows.
 *
 * Overrides are awaited and allowed to fail the request: the whole purpose of
 * an override is that it leaves a record, so a change that could not be
 * recorded must not happen. Ordinary edits log best-effort — losing an audit
 * row is bad, but refusing a teacher's marks because a secondary write blipped
 * is worse.
 */
const logResultChange = async (context, entries) => {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return [];

  const now  = new Date();
  const rows = list.map((e) => ({
    schoolId:      context.schoolId,
    examId:        context.examId,
    studentId:     e.studentId ?? context.studentId ?? null,
    subjectId:     e.subjectId ?? context.subjectId ?? null,
    entity:        e.entity,
    entityId:      e.entityId ?? null,
    action:        e.action,
    field:         e.field    ?? null,
    oldValue:      e.oldValue ?? null,
    newValue:      e.newValue ?? null,
    reason:        e.reason   ?? context.reason ?? null,
    isOverride:    Boolean(context.isOverride),
    changedBy:     context.actor?.id   ?? null,
    changedByName: context.actor?.name ?? null,
    changedByRole: context.actor?.role ?? null,
    changedAt:     now,
    batchId:       context.batchId ?? null,
  }));

  if (context.isOverride) {
    return ResultChangeLog.insertMany(rows, { ordered: true });
  }

  try {
    return await ResultChangeLog.insertMany(rows, { ordered: false });
  } catch (err) {
    console.error("[resultAudit] log write failed:", err.message);
    return [];
  }
};

/**
 * Build a field-level entry only when the value actually moved.
 *
 * Without this every bulk save would write a row per student per field even
 * when a teacher re-saved an unchanged sheet, and the history would be
 * unreadable within a term.
 */
const diffField = (field, oldValue, newValue) => {
  const a = oldValue ?? null;
  const b = newValue ?? null;
  if (a === b) return null;
  if (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()) return null;
  return { field, oldValue: a, newValue: b };
};

module.exports = {
  isAdmin,
  getProtection,
  guardResultWrite,
  logResultChange,
  diffField,
};
