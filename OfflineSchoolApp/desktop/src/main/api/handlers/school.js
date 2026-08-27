// desktop/src/main/api/handlers/school.js
"use strict";

/**
 * The shape of the school: classes and subjects.
 *
 * ── The subtlety here is the sort order ───────────────────────────────────
 *
 * These lists are sorted by MongoDB — .sort({ name: 1 }) — and Mongo compares
 * strings by their bytes. The pupil roster in handlers/students.js is sorted by
 * the SERVER IN JAVASCRIPT, with localeCompare, after the documents come back.
 *
 * The two disagree, and not subtly. Binary comparison puts every uppercase
 * letter before every lowercase one, so "Zebra" sorts before "apple";
 * localeCompare puts "apple" first. A school with a class named "form 1"
 * alongside "Form 2" would see them in one order online and another offline,
 * which reads as the list being unstable rather than as two sorts.
 *
 * So these use plain comparison to match Mongo, and the roster uses
 * localeCompare to match the server's JavaScript. Neither is "the right way to
 * sort names" — each is the way its endpoint already does it, which is the only
 * thing that matters for a mirror.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * MongoDB's ascending string order.
 *
 * Byte comparison, which for the names in this data means code-unit order.
 * Deliberately NOT localeCompare — see the note above.
 */
const byMongoName = (a, b) => {
  const an = String(a.name ?? "");
  const bn = String(b.name ?? "");
  if (an === bn) return 0;
  return an < bn ? -1 : 1;
};

module.exports = [
  {
    route: "GET /api/admin/classes",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      // includeInactive=true drops BOTH filters, deleted rows included. That is
      // what the endpoint does — the two conditions are applied together — and
      // a mirror that kept the not-deleted filter would show fewer classes than
      // the server for the one caller who asked to see everything.
      const includeInactive = query.includeInactive === "true";

      const filter = includeInactive
        ? { schoolId }
        : { schoolId, isActive: true, deletedAt: null };

      const classes = docs.find("class", filter).sort(byMongoName);

      return ok({ classes });
    },
  },

  {
    route: "GET /api/admin/subjects",

    /**
     * Subjects, with their class and the teacher who takes them.
     *
     * Three collections merged rather than one listed, and almost every line
     * below is reproducing a specific decision the endpoint makes rather than an
     * obvious one:
     *
     *   · NO deleted filter. The endpoint does not apply one, so neither does
     *     this — a mirror that "improved" on it would show fewer subjects than
     *     the server and the difference would look like missing data.
     *
     *   · classId matches EITHER `class` OR `classId` on the document. Both
     *     spellings are in the data and the endpoint accepts both.
     *
     *   · The joined class is PROJECTED to name, section and level. The mirror
     *     holds whole class documents, so sending the whole thing would attach
     *     fields the server never sends.
     *
     *   · The teacher map takes the FIRST assignment for a subject and ignores
     *     the rest. Two teachers on one subject is possible in the data, and the
     *     endpoint shows one of them — the first it happens to read.
     *
     *   · A teacher id that resolves to no user produces NO teacher. That is
     *     what populate does when it finds nothing — it sets the field to null
     *     rather than leaving the id behind, so the endpoint's `if (t)` fails
     *     and the subject comes back unassigned. This handler had it the other
     *     way round at first, attaching a teacher with empty strings for name
     *     and email, and the parity harness caught it.
     *
     *     One consequence is worth naming: locally, "no such user" also covers
     *     "that user has not synced to this machine yet", so a freshly-installed
     *     desktop can show a subject as unassigned when the server knows who
     *     teaches it. It corrects itself when the user collection arrives, and
     *     the alternative — a teacher with a blank name — would be a worse thing
     *     to put on a screen.
     *
     *   · Finally deduped by lower-cased name plus class, first wins.
     */
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const classId = query.classId ? String(query.classId).trim() : null;

      // No deletedAt condition — see the note above.
      let raw = docs.find("subject", { schoolId });

      if (classId) {
        raw = raw.filter((s) =>
          String(s.class ?? "") === classId || String(s.classId ?? "") === classId);
      }

      raw = raw.sort(byMongoName);
      if (!raw.length) return ok({ subjects: [] });

      // ── The class join, projected as the server projects it ──────────────
      const classIds = [...new Set(
        raw.map((s) => s.class || s.classId).filter(Boolean).map(String)
      )];

      const classMap = new Map();
      for (const id of classIds) {
        const record = docs.get("class", id);
        if (!record) continue;
        // .select("name section level") — plus _id, which Mongo always returns.
        classMap.set(id, {
          _id:     record._id,
          name:    record.name,
          section: record.section,
          level:   record.level,
        });
      }

      // ── The teacher join ────────────────────────────────────────────────
      const subjectIds = new Set(raw.map((s) => String(s._id)));
      const assignments = docs.find("teacherAssignment", { schoolId });

      const subjectTeacher = new Map();
      for (const a of assignments) {
        const sid = String(a.subject?._id ?? a.subject ?? "");
        if (!sid || !subjectIds.has(sid) || subjectTeacher.has(sid)) continue;

        // `teacher` only. The endpoint reads a.teacher and nothing else, so an
        // assignment recorded under teacherId attaches no teacher there either —
        // reproducing that rather than being cleverer than it.
        const ref = a.teacher;
        if (!ref) continue;

        const id   = String(ref?._id ?? ref);
        const user = docs.get("user", id);

        // No user, no teacher — populate sets the field to null when it finds
        // nothing, so the endpoint attaches nothing. See the note above.
        if (!user) continue;

        subjectTeacher.set(sid, {
          _id:   id,
          name:  user.name  ?? "",
          email: user.email ?? "",
        });
      }

      const subjects = raw.map((s) => {
        const canonicalClassId = s.class || s.classId || null;
        const classRecord = canonicalClassId
          ? classMap.get(String(canonicalClassId)) ?? null
          : null;
        const teacher = subjectTeacher.get(String(s._id)) ?? null;

        return {
          ...s,
          class:    canonicalClassId,
          classId:  canonicalClassId,
          classObj: classRecord ? { _id: String(classRecord._id), ...classRecord } : null,
          teacherId:   teacher?._id  || s.teacherId  || s.teacher_id || null,
          teacher_id:  teacher?._id  || s.teacher_id || s.teacherId  || null,
          teacherName: teacher?.name || s.teacherName || null,
          teacher:     teacher       || null,
        };
      });

      // Deduped on name and class, first kept. Two subjects with the same name
      // in the same class is a data-entry artefact the endpoint hides.
      const seen = new Set();
      const deduped = subjects.filter((s) => {
        const key = `${(s.name || "").toLowerCase().trim()}|${s.class || s.classId || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return ok({ subjects: deduped });
    },
  },
];
