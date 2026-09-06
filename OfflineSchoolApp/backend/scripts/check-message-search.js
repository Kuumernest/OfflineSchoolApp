// backend/scripts/check-message-search.js
"use strict";

/**
 * Finding a conversation by the name of somebody in it.
 *
 * The audit list could only be searched by an exact participant id, which is a
 * thing an administrator has to go and look up somewhere else before the page
 * is usable at all.
 *
 * A regex over participants.name would have found staff and nobody else. The
 * name stored on a participant is whatever was denormalised when the thread was
 * created, and for a guardian that is the literal string "Parent/Guardian" —
 * the children are attached when the row is read, not when it is written. A
 * parent has no name of their own anywhere in this system.
 *
 * So a parent is found the way a school thinks of them: match the child, and
 * the parent is whoever holds that child. These assertions are mostly about
 * that one hop, because it is the half that does not work by accident.
 *
 *   node scripts/check-message-search.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User           = mongoose.model("User");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const School         = mongoose.model("School");
  const Conversation   = mongoose.model("Conversation");
  const GuardianAccess = mongoose.model("GuardianAccess");

  const S = "6a9c68282000b4be2fae75cc";

  await School.create({
    _id: S, name: "A School", settings: { adminAudit: true },
  }).catch(() => {});

  const mk = (id, role, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId: S, isActive: true,
  });
  await mk("adm-1", "school_admin", "Head Teacher");
  await mk("tea-1", "teacher", "Mrs Grace Johnson");
  await mk("tea-2", "teacher", "Mr Buh");

  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  await Student.create({
    _id: "st-1", userId: "u-st-1", schoolId: S, classId: "cls-1",
    studentName: "Bern Constance", enrollmentNo: "E-1", isActive: true,
  });

  await GuardianAccess.create({
    _id: "acc-1", schoolId: S, studentIds: ["st-1"],
    codeHash: "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad",
    codeHint: "11",
  });

  // The thread that matters: a parent and a teacher. Nothing in it holds the
  // child's name — that is the whole difficulty.
  await Conversation.create({
    _id: "cv-parent", schoolId: S, kind: "direct",
    directKey: "guardian:acc-1|user:tea-1",
    participants: [
      { kind: "guardian", id: "acc-1", name: "Parent/Guardian" },
      { kind: "user",     id: "tea-1", name: "Mrs Grace Johnson", role: "teacher" },
    ],
  });

  // A staff thread, and a class thread with a roll call in it.
  await Conversation.create({
    _id: "cv-staff", schoolId: S, kind: "direct",
    directKey: "user:tea-1|user:tea-2",
    participants: [
      { kind: "user", id: "tea-1", name: "Mrs Grace Johnson", role: "teacher" },
      { kind: "user", id: "tea-2", name: "Mr Buh", role: "teacher" },
    ],
  });

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const token = jwt.sign({ id: "adm-1", role: "school_admin", schoolId: S },
    process.env.JWT_SECRET, { expiresIn: "1h" });

  const search = async (q) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/messages/audit/conversations?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, rows: body?.conversations ?? [], body };
  };

  const ids = (r) => r.rows.map((c) => c._id).sort();

  // ── The baseline: everything, then a staff name ───────────────────────────
  console.log("\n--- searching by a staff name ---");

  let r = await search("");
  if (r.status === 200) ok(`the audit list answers (${r.rows.length} thread(s) unfiltered)`);
  else bad("the audit list answers", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

  r = await search("Grace");
  if (ids(r).join() === "cv-parent,cv-staff") ok("a teacher's name finds both of their threads");
  else bad("a teacher's name finds their threads", JSON.stringify(ids(r)));

  r = await search("Buh");
  if (ids(r).join() === "cv-staff") ok("and a name in only one thread finds only that one");
  else bad("a name in one thread finds one", JSON.stringify(ids(r)));

  // ── The hop that does not work by accident ────────────────────────────────
  console.log("\n--- searching by a pupil's name, to find their parent ---");

  r = await search("Bern");
  if (ids(r).join() === "cv-parent") {
    ok("a pupil's name finds the thread with their parent");
  } else {
    bad("a pupil's name finds their parent's thread",
      `got ${JSON.stringify(ids(r))}. Nothing stored on that conversation holds ` +
      "the child's name — the guardian participant reads \"Parent/Guardian\" — so " +
      "the search has to resolve the pupil, then the access that holds them.");
  }

  r = await search("Constance");
  if (ids(r).join() === "cv-parent") ok("a surname works the same way");
  else bad("a surname works the same way", JSON.stringify(ids(r)));

  // And the row that comes back has to show why it matched.
  const parentRow = r.rows.find((c) => c._id === "cv-parent");
  const guardian  = (parentRow?.participants ?? []).find((p) => p.kind === "guardian");
  if (guardian?.name?.includes("Bern Constance")) {
    ok(`the row names the child it matched on ("${guardian.name}")`);
  } else {
    bad("the row names the child it matched on",
      `${JSON.stringify(guardian?.name)} — an administrator who searched "Constance" ` +
      "and got back a row saying only \"Parent/Guardian\" cannot tell why it matched.");
  }

  if (Array.isArray(guardian?.childNames) && guardian.childNames.includes("Bern Constance")) {
    ok("and carries the children structured, for a client that would rather draw them");
  } else {
    bad("the row carries childNames", JSON.stringify(guardian?.childNames));
  }

  // ── Nothing, and everything ───────────────────────────────────────────────
  console.log("\n--- the edges ---");

  r = await search("Nobody By That Name");
  if (r.rows.length === 0) ok("a name nobody has finds nothing");
  else bad("a name nobody has finds nothing", JSON.stringify(ids(r)));

  r = await search("e");
  if (r.rows.length >= 2) ok("a single letter still matches broadly rather than exactly");
  else bad("a single letter matches broadly", JSON.stringify(ids(r)));

  // A regex metacharacter must not blow up or match everything.
  r = await search("Grace(");
  if (r.status === 200 && r.rows.length === 0) ok("a regex metacharacter is searched for literally, not executed");
  else bad("a metacharacter is escaped", `${r.status} ${JSON.stringify(ids(r))}`);

  // ── The web list summarises rather than printing a roll call ──────────────
  console.log("\n--- the class roll call that overflowed the page ---");

  const WEB = path.join(ROOT, "..", "web", "src", "pages", "messages");
  const read = (f) => { try { return require("fs").readFileSync(path.join(WEB, f), "utf8"); } catch { return null; } };

  const auditPage = read("audit.tsx");
  if (auditPage && /summariseParticipants\(/.test(auditPage) && /max-w-0/.test(auditPage)) {
    ok("the audit row summarises its participants inside a width that can truncate");
  } else {
    bad("the audit row summarises and truncates",
      "a class thread holds every pupil in the class; joining forty-two names " +
      "with commas made one unbreakable line and pushed the table off the page. " +
      "truncate alone does nothing in a table cell with no width to truncate against.");
  }

  const listPage = read("index.tsx");
  if (listPage && /conversationMatches\(/.test(listPage)) {
    ok("the message list has a search of its own");
  } else {
    bad("the message list has a search", "index.tsx does not filter its conversations");
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
