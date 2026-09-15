// backend/scripts/backfill-question-subjects.js
"use strict";

/**
 * Give the questions that already exist a subject.
 *
 * ── Why this is a script and not a migration ──────────────────────────────
 *
 * Question.subject_id is new. Nothing breaks without it: a question with no
 * subject is simply in no subject's bank, which is the honest answer for a row
 * nobody has placed. What this does is place the ones the data already places
 * — a question used in a Mathematics quiz is a Mathematics question — and only
 * those. A question used in quizzes of two subjects is left alone for its
 * teacher, and one used in no quiz at all has nothing to say for itself.
 *
 * The phone does the same for its own SQLite on start (db/quizSchema.js), so
 * the two mirrors agree; a phone's row pushed later carries its subject and
 * wins on the server through the ordinary update.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * Touch a subject that is already set, delete anything, or guess.
 *
 *   node scripts/backfill-question-subjects.js            # report only
 *   node scripts/backfill-question-subjects.js --apply    # write
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path     = require("path");

const APPLY = process.argv.includes("--apply");

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("MONGODB_URI is not set"); process.exit(1); }
  await mongoose.connect(uri);

  require(path.join(__dirname, "..", "src", "db", "models"));
  const { Question, Quiz } = require(path.join(__dirname, "..", "src", "db", "models", "QuizModule"));

  const quizzes = await Quiz.find({ deleted_at: null, subject_id: { $nin: [null, ""] } })
    .select("subject_id questions.question_id").lean();

  // question id → set of subject ids across the quizzes it sits in
  const subjectsOf = new Map();
  for (const qz of quizzes) {
    for (const qq of qz.questions ?? []) {
      const qid = String(qq.question_id);
      if (!subjectsOf.has(qid)) subjectsOf.set(qid, new Set());
      subjectsOf.get(qid).add(String(qz.subject_id));
    }
  }

  const unplaced = await Question.find({ deleted_at: null, $or: [{ subject_id: null }, { subject_id: "" }] })
    .select("_id question_text created_by").lean();

  let placed = 0, ambiguous = 0, orphan = 0;
  for (const q of unplaced) {
    const subs = subjectsOf.get(String(q._id));
    if (!subs || subs.size === 0) { orphan++; continue; }
    if (subs.size > 1) { ambiguous++; console.log(`  ambiguous  ${q._id}  "${q.question_text}"  in ${[...subs].join(", ")}`); continue; }
    const [subjectId] = [...subs];
    if (APPLY) await Question.updateOne({ _id: q._id }, { $set: { subject_id: subjectId } });
    placed++;
  }

  console.log(`\n${unplaced.length} question(s) without a subject: ` +
    `${placed} ${APPLY ? "placed" : "placeable"}, ${ambiguous} ambiguous, ${orphan} in no quiz.` +
    (APPLY ? "" : "  (run with --apply to write)"));

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
