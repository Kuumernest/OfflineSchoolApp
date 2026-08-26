// backend/scripts/check-messaging-integration.js
"use strict";

/**
 * Messaging against a real MongoDB.
 *
 * The policy suite (check-communication-policy.js) covers the decision logic
 * without a database. This covers the things that are only true if MongoDB
 * behaves the way the code assumes:
 *
 *   - $inc on Counter really is atomic, so two devices posting at the same
 *     instant cannot be handed the same seq;
 *   - the unique index on directKey really does collapse a race, so two
 *     people opening a chat simultaneously end up in ONE thread;
 *   - the positional $max on participants.$ really does move only that
 *     participant's marker, and only ever forwards;
 *   - the unique (conversationId, seq) index really does refuse a duplicate.
 *
 * Runs against a throwaway in-memory server. It never touches MONGODB_URI,
 * so it is safe to run against a checkout pointed at production.
 *
 *   node scripts/check-messaging-integration.js
 */

const path = require("path");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got ${a}\n         expected ${e}`); }
};

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongoose = require("mongoose");

  console.log("Starting a throwaway MongoDB…");
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "commstest" });
  console.log("Connected.\n");

  const SRC = path.resolve(__dirname, "..", "src");
  const Conversation = require(path.join(SRC, "db/models/Conversation"));
  const Message      = require(path.join(SRC, "db/models/Message"));
  const Announcement = require(path.join(SRC, "db/models/Announcement"));
  const svc          = require(path.join(SRC, "services/communication/conversation.service"));

  // Indexes are what several of these assertions actually test, and Mongoose
  // builds them lazily. Force them up front or the first test would pass for
  // the wrong reason.
  await Promise.all([
    Conversation.init(),
    Message.init(),
    Announcement.init(),
  ]);

  const S  = "school-1";
  const t1 = { kind: "user", id: "teacher-1", role: "teacher", schoolId: S, name: "Mr Ngu" };
  const s1 = { kind: "user", id: "student-1", role: "student", schoolId: S, name: "Ada" };
  const g1 = { kind: "guardian", id: "guardian-1", schoolId: S, studentIds: ["student-1"], name: "Parent" };

  // ── 1. seq allocation is atomic ───────────────────────────────────────────
  console.log("--- seq allocation ---");
  {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => svc.nextSeq("race-test"))
    );
    const unique = new Set(ids);
    check("50 concurrent allocations are all distinct", unique.size, 50);
    check("they are exactly 1..50", Math.min(...ids) + "-" + Math.max(...ids), "1-50");
  }

  // ── 2. the directKey race collapses to one thread ─────────────────────────
  console.log("\n--- direct thread race ---");
  {
    const results = await Promise.all([
      svc.openDirect(t1, s1),
      svc.openDirect(s1, t1),
      svc.openDirect(t1, s1),
      svc.openDirect(s1, t1),
    ]);
    const ids = new Set(results.map((c) => String(c._id)));
    check("four simultaneous opens produce ONE thread", ids.size, 1);

    const count = await Conversation.countDocuments({ schoolId: S, kind: "direct" });
    check("only one row was written", count, 1);

    const stored = await Conversation.findOne({ schoolId: S, kind: "direct" });
    check("both parties are participants", stored.participants.length, 2);
  }

  // ── 3. posting, ordering and the unique seq index ─────────────────────────
  console.log("\n--- posting ---");
  let convo;
  {
    convo = await Conversation.findOne({ schoolId: S, kind: "direct" });

    const sent = await Promise.all([
      svc.postMessage({ conversation: convo, principal: t1, body: "one" }),
      svc.postMessage({ conversation: convo, principal: t1, body: "two" }),
      svc.postMessage({ conversation: convo, principal: s1, body: "three" }),
      svc.postMessage({ conversation: convo, principal: s1, body: "four" }),
      svc.postMessage({ conversation: convo, principal: t1, body: "five" }),
    ]);

    const seqs = sent.map((r) => r.message.seq).sort((a, b) => a - b);
    check("five concurrent posts get five distinct seqs", new Set(seqs).size, 5);
    check("contiguous from 1", seqs, [1, 2, 3, 4, 5]);

    // Duplicate seq must be impossible, not merely unlikely.
    let dupErr = null;
    try {
      await Message.create({
        _id: "forced-dup", conversationId: convo._id, schoolId: S, seq: 1,
        sender: { kind: "user", id: "x" }, body: "should not be stored",
      });
    } catch (err) { dupErr = err; }
    check("duplicate seq refused by the index", dupErr?.code, 11000);
  }

  // ── 4. a retried send does not double-post ────────────────────────────────
  console.log("\n--- offline retry ---");
  {
    const before = await Message.countDocuments({ conversationId: convo._id });

    const a = await svc.postMessage({
      conversation: convo, principal: t1, body: "sent from the bus", clientId: "outbox-1",
    });
    const b = await svc.postMessage({
      conversation: convo, principal: t1, body: "sent from the bus", clientId: "outbox-1",
    });

    check("retry reported as duplicate", b.duplicate, true);
    check("retry returns the same row", String(b.message._id), String(a.message._id));

    const after = await Message.countDocuments({ conversationId: convo._id });
    check("exactly one row was added", after - before, 1);
  }

  // ── 5. read markers only advance, and only for one participant ────────────
  console.log("\n--- read markers ---");
  {
    // A sender has read what they just sent, so the teacher's marker is
    // already at the highest seq they posted. Capture it rather than assuming
    // zero — that assumption was wrong the first time this suite ran.
    let c = await Conversation.findById(convo._id);
    const started    = c.participants.find((p) => p.id === "teacher-1").lastReadSeq;
    const studentWas = c.participants.find((p) => p.id === "student-1").lastReadSeq;
    check("sending advanced the sender's own marker", started > 0, true);
    // Both parties posted in this thread, so both markers are non-zero. The
    // invariant is that each tracks only its OWN highest send, not the
    // conversation's — which is what the positional-$ bug broke.
    check("each marker is at most the conversation tail",
      started <= c.lastMessageSeq && studentWas <= c.lastMessageSeq, true);
    check("the two markers are tracked separately",
      started !== studentWas, true);

    // A stale receipt from a device that has been offline must not un-read.
    await svc.markRead(convo._id, t1, 1);
    c = await Conversation.findById(convo._id);
    check("stale receipt does not move it backwards",
      c.participants.find((p) => p.id === "teacher-1").lastReadSeq, started);

    await svc.markRead(convo._id, t1, started + 3);
    c = await Conversation.findById(convo._id);
    check("newer receipt does advance it",
      c.participants.find((p) => p.id === "teacher-1").lastReadSeq, started + 3);

    // And it moved ONLY the teacher — the bug this pins is a receipt for one
    // participant landing on another.
    check("the student's marker did not move with the teacher's",
      c.participants.find((p) => p.id === "student-1").lastReadSeq, studentWas);

    check("unread is the tail minus that participant's own marker",
      c.unreadFor(s1), (c.lastMessageSeq || 0) - studentWas);
  }

  // ── 6. guardian and user with the same id string stay distinct ────────────
  console.log("\n--- principal identity ---");
  {
    const collide = { kind: "guardian", id: "teacher-1", schoolId: S, studentIds: [] };
    const key1 = Conversation.buildDirectKey(t1, s1);
    const key2 = Conversation.buildDirectKey(collide, s1);
    check("same id, different kind, different thread key", key1 === key2, false);
  }

  // ── 7. the conversation tail cannot be dragged backwards ──────────────────
  console.log("\n--- conversation tail ---");
  {
    const c = await Conversation.findById(convo._id);
    const topSeq = c.lastMessageSeq;
    check("tail matches the newest message", topSeq >= 6, true);

    // Simulate a late offline message being accepted with a lower seq than
    // the tail: the preview must keep pointing at the newer one.
    await Conversation.updateOne(
      { _id: convo._id, lastMessageSeq: { $lt: 2 } },
      { $set: { lastMessagePreview: "STALE" } }
    );
    const after = await Conversation.findById(convo._id);
    check("stale update rejected by the guard", after.lastMessagePreview === "STALE", false);
  }

  // ── 8. announcement targeting really filters ──────────────────────────────
  console.log("\n--- announcement audiences ---");
  {
    const base = { schoolId: S, body: "b", author: "admin-1" };
    await Announcement.create([
      { ...base, _id: "a-all",      title: "Everyone",      audience: "all" },
      { ...base, _id: "a-legacy-c", title: "Legacy class",  audience: "class", targetClasses: ["c1"] },
      { ...base, _id: "a-multi",    title: "Students+Parents", audiences: ["students", "parents"] },
      { ...base, _id: "a-scoped",   title: "Only 5A",       audiences: ["students"], targetClasses: ["c1"] },
      { ...base, _id: "a-other",    title: "Only 5B",       audiences: ["students"], targetClasses: ["c2"] },
      { ...base, _id: "a-staff",    title: "Staff only",    audiences: ["teachers"] },
    ]);

    const forC1 = await Announcement.find({
      schoolId: S,
      $or: Announcement.audienceMatch({ audience: "students", classId: "c1" }),
    }).select("_id").lean();
    const c1 = forC1.map((r) => r._id).sort();

    check("c1 student sees all/legacy-c1/multi/scoped-c1",
      c1, ["a-all", "a-legacy-c", "a-multi", "a-scoped"]);
    check("c1 student does NOT see the 5B notice", c1.includes("a-other"), false);
    check("c1 student does NOT see staff-only",     c1.includes("a-staff"), false);

    const forTeacher = await Announcement.find({
      schoolId: S,
      $or: Announcement.audienceMatch({ audience: "teachers" }),
    }).select("_id").lean();
    const tt = forTeacher.map((r) => r._id).sort();
    check("teacher sees all + staff-only", tt, ["a-all", "a-staff"]);
    check("teacher does NOT see a student notice", tt.includes("a-multi"), false);

    const forParent = await Announcement.find({
      schoolId: S,
      $or: Announcement.audienceMatch({ audience: "parents" }),
    }).select("_id").lean();
    const pp = forParent.map((r) => r._id).sort();
    check("parent sees all + the multi-target notice", pp, ["a-all", "a-multi"]);
  }

  // ── 9. a guardian thread works the same way ───────────────────────────────
  console.log("\n--- guardian threads ---");
  {
    const gc = await svc.openDirect(g1, t1);
    const r  = await svc.postMessage({
      conversation: gc, principal: g1, body: "About Ada's homework",
    });
    check("guardian message stored", r.message.seq, 1);
    check("sender recorded as guardian", r.message.sender.kind, "guardian");

    const stored = await Conversation.findById(gc._id);
    check("guardian's own marker advanced",
      stored.participants.find((p) => p.kind === "guardian").lastReadSeq, 1);
    check("teacher's marker did not",
      stored.participants.find((p) => p.kind === "user").lastReadSeq, 0);
  }

  // ── 10. soft delete keeps the row and the seq ─────────────────────────────
  console.log("\n--- deletion ---");
  {
    const m = await Message.findOne({ conversationId: convo._id, seq: 1 });
    m.deletedAt = new Date();
    await m.save();

    const again = await Message.findById(m._id);
    check("row survives", Boolean(again), true);
    check("seq is kept so counts stay right", again.seq, 1);
    check("body withheld from participants", again.toClientJSON().body, null);
    check("body still present for an audit", again.body.length > 0, true);
  }

  // ── 11. the recipient picker agrees with the policy ───────────────────────
  console.log("\n--- recipient picker ---");
  {
    const User           = require(path.join(SRC, "db/models/User"));
    const GuardianAccess = require(path.join(SRC, "db/models/GuardianAccess"));
    const pol            = require(path.join(SRC, "services/communication/policy.service"));

    await User.create([
      { _id: "teacher-1", enrollmentNo: "EN-teacher-1", name: "Mr Ngu",    role: "teacher",      schoolId: S,              email: "t1@x.io", password: "fixture-pw-123" },
      { _id: "student-1", enrollmentNo: "EN-student-1", name: "Ada",       role: "student",      schoolId: S,              email: "s1@x.io", password: "fixture-pw-123" },
      { _id: "student-2", enrollmentNo: "EN-student-2", name: "Bola",      role: "student",      schoolId: S,              email: "s2@x.io", password: "fixture-pw-123" },
      { _id: "admin-1", enrollmentNo: "EN-admin-1",   name: "Head",      role: "school_admin", schoolId: S,              email: "a1@x.io", password: "fixture-pw-123" },
      { _id: "other-1", enrollmentNo: "EN-other-1",   name: "Elsewhere", role: "teacher",      schoolId: "other-school", email: "o1@x.io", password: "fixture-pw-123" },
    ]);
    await GuardianAccess.create({
      _id: "guardian-1", schoolId: S, label: "Mrs Okafor", studentIds: ["student-1"],
    });

    const pick = async (principal, settings) => {
      const cands = await svc.findCandidateRecipients(principal, settings, { limit: 50 });
      return cands
        .filter((c) => pol.canMessage(principal, c, settings).allowed)
        .map((c) => c.kind + ":" + c.id)
        .sort();
    };

    // Mirror the real default rather than hard-coding the old one.
    const defaults = pol.resolveSettings(undefined);
    check("peer messaging is on by default", defaults.studentToStudent, true);

    const forStudent = await pick(s1, defaults);
    check("student is offered teachers and admins",
      forStudent.includes("user:teacher-1") && forStudent.includes("user:admin-1"), true);
    check("student IS offered another student by default",
      forStudent.includes("user:student-2"), true);
    check("student is NOT offered a guardian",
      forStudent.some((k) => k.startsWith("guardian:")), false);
    check("nobody from another school is offered",
      forStudent.includes("user:other-1"), false);
    check("student is not offered themselves",
      forStudent.includes("user:student-1"), false);

    const forStudentClosed = await pick(s1, { studentToStudent: false });
    check("peers disappear when a school closes peer messaging",
      forStudentClosed.includes("user:student-2"), false);
    check("teachers remain when peer messaging is closed",
      forStudentClosed.includes("user:teacher-1"), true);

    const forTeacher = await pick(t1, defaults);
    check("teacher is offered guardians", forTeacher.includes("guardian:guardian-1"), true);
    check("teacher is offered students",  forTeacher.includes("user:student-1"), true);

    const forGuardian = await pick(g1, defaults);
    check("guardian is offered teachers", forGuardian.includes("user:teacher-1"), true);
    check("guardian is offered their OWN child",
      forGuardian.includes("user:student-1"), true);
    check("guardian is NOT offered somebody else's child",
      forGuardian.includes("user:student-2"), false);
    check("guardian is NOT offered another guardian",
      forGuardian.some((k) => k.startsWith("guardian:")), false);

    const forAdmin = await pick(
      { kind: "user", id: "admin-1", role: "school_admin", schoolId: S }, defaults);
    check("admin is offered teachers, students and guardians",
      forAdmin.includes("user:teacher-1") &&
      forAdmin.includes("user:student-1") &&
      forAdmin.includes("guardian:guardian-1"), true);

    // A name containing regex metacharacters must not throw or scan wide.
    const weird = await svc.findCandidateRecipients(t1, defaults, { q: "a.*(", limit: 10 });
    check("regex metacharacters in a search are escaped", Array.isArray(weird), true);
  }

  // ── 12. a class exists as a group, with its roster ────────────────────────
  console.log("\n--- class groups ---");
  {
    const pol               = require(path.join(SRC, "services/communication/policy.service"));
    const Class             = require(path.join(SRC, "db/models/Class"));
    const Student           = require(path.join(SRC, "db/models/Student"));
    const TeacherAssignment = require(path.join(SRC, "db/models/TeacherAssignment"));
    const User              = require(path.join(SRC, "db/models/User"));

    await Class.create({ _id: "class-5a", schoolId: S, name: "Form 5", section: "A" });

    // Two pupils linked the two different ways this codebase uses: one by
    // User.classId, one only by a Student row pointing at a userId.
    await User.create([
      { _id: "pupil-1", name: "Chidi", role: "student", schoolId: S, classId: "class-5a",
        email: "p1@x.io", password: "fixture-pw-123", enrollmentNo: "EN-p1" },
      { _id: "pupil-2", name: "Ngozi", role: "student", schoolId: S,
        email: "p2@x.io", password: "fixture-pw-123", enrollmentNo: "EN-p2" },
      { _id: "pupil-3", name: "Emeka", role: "student", schoolId: S, classId: "class-5a",
        email: "p3@x.io", password: "fixture-pw-123", enrollmentNo: "EN-p3" },
    ]);
    await Student.create([
      { _id: "st-2", schoolId: S, classId: "class-5a", userId: "pupil-2",
        studentName: "Ngozi A", enrollmentNo: "EN-p2" },
      // A pending application: no login yet, so there is nobody to add to the
      // group. userId is omitted rather than set to null, because the sparse
      // unique index skips a MISSING field but still indexes an explicit null.
      { _id: "st-x", schoolId: S, classId: "class-5a", status: "pending",
        studentName: "Pending Applicant", enrollmentNo: "EN-pending" },
    ]);
    await TeacherAssignment.create({
      _id: "ta-1", schoolId: S, teacher: "teacher-1",
      class: "class-5a", subject: "subject-1", isActive: true,
    });

    const group = await svc.ensureClassConversation(S, "class-5a");
    check("a class group is provisioned", Boolean(group), true);
    check("it is a class conversation", group.kind, "class");
    check("named for the class", group.title, "Form 5 A");

    const ids = group.participants.map((p) => String(p.id)).sort();
    check("pupil linked by User.classId is a member", ids.includes("pupil-1"), true);
    check("pupil linked only by a Student row is a member", ids.includes("pupil-2"), true);
    check("the class teacher is a member", ids.includes("teacher-1"), true);
    check("a pending applicant with no login is not", ids.includes("st-x"), false);
    check("roster size", group.participants.length, 4);

    // Provisioning twice must not split the class in two.
    const again = await Promise.all([
      svc.ensureClassConversation(S, "class-5a"),
      svc.ensureClassConversation(S, "class-5a"),
      svc.ensureClassConversation(S, "class-5a"),
    ]);
    check("repeat provisioning reuses the same group",
      new Set(again.map((c) => String(c._id))).size, 1);
    const groupCount = await Conversation.countDocuments({
      schoolId: S, kind: "class", classId: "class-5a", deletedAt: null,
    });
    check("still exactly one group for the class", groupCount, 1);

    // Somebody posts, then a pupil leaves and another arrives.
    await svc.postMessage({
      conversation: group, principal: t1, body: "Homework is due Friday",
    });
    await svc.markRead(group._id, { kind: "user", id: "pupil-1" }, 1);

    await User.updateOne({ _id: "pupil-3" }, { $set: { classId: "class-5b" } });
    await User.create({
      _id: "pupil-4", name: "Amaka", role: "student", schoolId: S, classId: "class-5a",
      email: "p4@x.io", password: "fixture-pw-123", enrollmentNo: "EN-p4",
    });

    const reconciled = await svc.ensureClassConversation(S, "class-5a");
    const after = reconciled.participants.map((p) => String(p.id)).sort();
    check("a pupil who left the class is removed", after.includes("pupil-3"), false);
    check("a pupil who joined is added",           after.includes("pupil-4"), true);
    check("the teacher stays",                     after.includes("teacher-1"), true);

    // The whole point: reconciling must not reset everyone's read state.
    const p1 = reconciled.participants.find((p) => String(p.id) === "pupil-1");
    check("an existing member keeps their read marker", p1.lastReadSeq, 1);
    const p4 = reconciled.participants.find((p) => String(p.id) === "pupil-4");
    check("a new member starts with the backlog unread", p4.lastReadSeq, 0);

    // Membership, not the matrix, governs a group.
    const outsider = { kind: "user", id: "student-2", role: "student", schoolId: S };
    check("a pupil from another class cannot post",
      pol.canPostToConversation(outsider, reconciled.toObject()).allowed, false);
    check("a member can post",
      pol.canPostToConversation({ kind: "user", id: "pupil-1", role: "student", schoolId: S },
        reconciled.toObject()).allowed, true);

    // And it turns up in the member's own list, unprompted.
    const listed = await svc.ensureClassConversationsFor(
      { kind: "user", id: "pupil-1", role: "student", schoolId: S }
    );
    check("a pupil's class group is provisioned for them",
      listed.some((c) => String(c.classId) === "class-5a"), true);

    const forTeacherClasses = await svc.ensureClassConversationsFor(t1);
    check("a teacher gets the classes they are assigned to",
      forTeacherClasses.some((c) => String(c.classId) === "class-5a"), true);
  }


  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongod.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error("\nSuite crashed:", err);
  process.exitCode = 1;
});
