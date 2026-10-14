// desktop/src/main/api/handlers/intelligence.js
"use strict";

/**
 * Student intelligence, answered from the mirror.
 *
 * ── Why this can exist now ────────────────────────────────────────────────
 *
 * Until the engine moved into shared/, these routes were online-only and the
 * coverage census said so: the ROWS were mirrored but the RULES were not, and a
 * second copy of them in this package would eventually disagree with the report
 * card about the same child.
 *
 * shared/intelligence/ is that engine. This file loads documents out of the
 * local mirror, hands them to the same functions the server hands them to, and
 * returns the same shape. There is no threshold, no ordering rule and no
 * confidence band in this file — if you find yourself adding one, it belongs in
 * shared/ where both sides read it.
 *
 * ── What the mirror can and cannot answer ─────────────────────────────────
 *
 * The inputs are all mirrored: resultSummary and exam under results.view and
 * exams.view, gradingConfig and academicStructure beside them, student scoped
 * to the classes a teacher actually teaches, and intervention scoped the same
 * way. So the calculation has everything it needs.
 *
 * What is NOT mirrored to a teacher is `class` and `teacherAssignment` — no
 * capability grants a teacher either, which config/syncFeed.js records as a
 * known gap. That has one consequence worth stating plainly: this package
 * cannot re-derive a teacher's class scope the way the server does. It does not
 * need to. The pupils in a teacher's mirror ARE the pupils they may see,
 * because the feed applied that scope when it sent them. Asking the mirror
 * "which pupils are in this class" therefore returns exactly the authorised set.
 *
 * The one case that leaves ambiguous is an empty answer: "you teach nobody in
 * this class" and "this class has no pupils" look identical locally, and the
 * server distinguishes them with 403 against 200. So an empty result DECLINES
 * rather than answering, and the request goes to the network to get the right
 * one. A mirror that answers differently from the server is worse than one that
 * says it cannot.
 *
 * ── Authorisation stays the server's ──────────────────────────────────────
 *
 * The capability check below mirrors the route's own guard so that a caller who
 * would be refused online is refused here too. It is not a substitute for the
 * server's: every write, and every read this declines, still meets the real
 * guard. Nothing about authorisation moved into shared/.
 */

const {
  subjectInsights, guidance, interventionOutcome, academicOrder,
} = require("../../../../../shared/intelligence");

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/** Either capability opens the subject routes, exactly as the router says. */
const maySeeIntelligence = (session) =>
  Boolean(session?.permissions?.includes("insights.view") ||
          session?.permissions?.includes("insights.viewTaught"));

const maySeeInterventions = (session) =>
  Boolean(session?.permissions?.includes("interventions.view") ||
          session?.permissions?.includes("interventions.viewTaught"));

/** A pupil's name, from whichever field the mirror holds it in. */
const displayName = (student) => {
  const stored = student?.studentName ?? student?.name;
  if (stored && String(stored).trim()) return String(stored).trim();
  return [student?.firstName, student?.lastName].filter(Boolean).join(" ").trim();
};

const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

/**
 * The school's grading rules, resolved by the shared engine from mirrored docs.
 *
 * A school with neither document mirrored gets the shipped defaults, which is
 * what the server would also return — resolveGradingContext reports that in
 * `passMarkSource` and `strongMarkBasis` rather than hiding it.
 */
const gradingFor = (docs, schoolId) => {
  const gradingConfig = docs.find("gradingConfig", { schoolId })[0] ?? null;
  const academicStructure = docs
    .find("academicStructure", { schoolId, deletedAt: null })
    .sort((a, b) => String(b.academicYear ?? "").localeCompare(String(a.academicYear ?? "")))[0] ?? null;

  return subjectInsights.resolveGradingContext({ gradingConfig, academicStructure });
};

/**
 * Published history for some pupils, ordered by the shared rule.
 *
 * isPublished is filtered here because the feed does not: resultSummary is
 * mirrored whole, and the server's own routes read published rows only. An
 * unpublished summary is a draft nobody has signed off.
 */
const historyFor = (docs, schoolId, studentIds) => {
  if (!studentIds.length) return new Map();

  const summaries = docs.find("resultSummary", {
    schoolId, isPublished: true, deletedAt: null, studentId: { in: studentIds },
  });
  if (!summaries.length) return new Map();

  const examIds = [...new Set(summaries.map((s) => String(s.examId)).filter(Boolean))];
  const exams = docs.find("exam", { _id: { in: examIds } });

  return academicOrder.orderPublishedHistory(summaries, exams);
};

module.exports = [
  {
    /*
     * GET /api/insights/class/:classId
     *
     * The teacher's scanning list: who to look at, and what is already open.
     */
    route: "GET /api/insights/class/:classId",
    handler: ({ params, query }, { docs, session }) => {
      if (!maySeeIntelligence(session)) return null;

      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const classId = String(params.classId);
      const students = docs.find("student", {
        schoolId, classId, status: "approved", deletedAt: null,
      });

      // The ambiguous case — see the header. Decline rather than answer "no
      // pupils" to somebody the server would have answered 403.
      if (!students.length) return null;

      const studentIds = students.map((s) => String(s._id));
      const grading = gradingFor(docs, schoolId);
      const historyByStudent = historyFor(docs, schoolId, studentIds);

      const profiles = subjectInsights.analyseHistories({
        historyByStudent, studentIds, grading,
      });

      // One read for the whole class, as the server does — not one per pupil.
      const open = docs.find("intervention", {
        schoolId, classId, deletedAt: null,
      }).filter((i) => i.status === "planned" || i.status === "active");

      const openByStudent = new Map();
      for (const row of open) {
        const id = String(row.studentId);
        const list = openByStudent.get(id);
        if (list) list.push(row); else openByStudent.set(id, [row]);
      }

      const rows = students.map((student) => {
        const id = String(student._id);
        const profile = profiles.get(id);
        return {
          studentId:    id,
          name:         displayName(student) || null,
          enrollmentNo: student.enrollmentNo ?? null,
          coverage:     profile?.coverage ?? null,
          insights:     profile?.insights ?? [],
          guidance: guidance.guidanceForProfile(profile).map((item) => ({
            type:          item.type,
            priority:      item.priority,
            subjectId:     item.subjectId ?? null,
            subjectName:   item.subjectName ?? null,
            rationaleCode: item.rationaleCode,
            confidence:    item.confidence,
          })),
          openInterventions: (openByStudent.get(id) ?? []).map((i) => ({
            _id: String(i._id), status: i.status, actionCode: i.actionCode,
            sourceType: i.sourceType, sourceCode: i.sourceCode ?? null,
            subjectId: i.subjectId ?? null, assignedTo: i.assignedTo ?? null,
            updatedAt: i.updatedAt,
          })),
        };
      }).sort(byName);

      // className is null when `class` is not in this caller's mirror, which is
      // the ordinary case for a teacher — see the header. The figure a teacher
      // came for is the list, not the label.
      const klass = docs.get("class", classId);

      return ok({
        data: {
          generatedAt: new Date(),
          classId,
          className: klass?.name ?? null,
          engine: { version: subjectInsights.ENGINE_VERSION, ...grading },
          counts: {
            students:     rows.length,
            withRisk:     rows.filter((r) => r.insights.some((i) => i.type === "risk")).length,
            withStrength: rows.filter((r) => r.insights.some((i) => i.type === "strength")).length,
          },
          students: rows,
        },
      });
    },
  },

  {
    /*
     * GET /api/insights/student/:studentId/guidance
     *
     * Why this pupil is listed, and what could be done about it.
     */
    route: "GET /api/insights/student/:studentId/guidance",
    handler: ({ params, query }, { docs, session }) => {
      if (!maySeeIntelligence(session)) return null;

      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const studentId = String(params.studentId);
      const student = docs.get("student", studentId);
      // Not in the mirror means either "not this school" or "not yours". The
      // server tells those apart with 404 against 403; this cannot, so it asks.
      if (!student || student.schoolId !== schoolId || student.deletedAt) return null;

      const grading = gradingFor(docs, schoolId);
      const historyByStudent = historyFor(docs, schoolId, [studentId]);

      const profile = subjectInsights.buildProfile({
        studentId,
        history: historyByStudent.get(studentId) ?? [],
        grading,
      });

      return ok({
        data: {
          generatedAt: new Date(),
          studentId,
          classId: student.classId ? String(student.classId) : null,
          guidance: guidance.guidanceForProfile(profile),
        },
      });
    },
  },

  {
    /*
     * GET /api/interventions/:id/evidence
     *
     * What the subject's marks looked like before this action started, and what
     * they look like now. An observation, never a verdict.
     */
    route: "GET /api/interventions/:id/evidence",
    handler: ({ params }, { docs, session }) => {
      if (!maySeeInterventions(session)) return null;

      const item = docs.get("intervention", String(params.id));
      if (!item || item.deletedAt) return null;

      const studentId = String(item.studentId);
      const historyByStudent = historyFor(docs, String(item.schoolId), [studentId]);

      return ok({
        data: interventionOutcome.compareOutcome({
          intervention: item,
          history: historyByStudent.get(studentId) ?? [],
        }),
      });
    },
  },
];
