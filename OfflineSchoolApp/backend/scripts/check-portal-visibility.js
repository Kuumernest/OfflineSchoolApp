// backend/scripts/check-portal-visibility.js
"use strict";

/**
 * Everything the portal will and will not show a parent.
 *
 * Two reported failures, and they turned out to live on opposite sides of the
 * wire — which is why this suite prints every id it uses and the raw response
 * body for the two endpoints in question. "The list is empty" is a claim about
 * a screen; the only way to argue about it is to look at what the server
 * actually said.
 *
 * ── The conversation list ─────────────────────────────────────────────────
 *
 * The server was never wrong, and this suite is here partly to keep saying so.
 * The web client asked for the wrong URL: its axios instance is created with
 * baseURL `/api/portal`, and all six messaging calls were written with the
 * full path — client.get("/portal/messages/conversations") — so every one of
 * them requested /api/portal/portal/… and 404'd. React Query then held no
 * data, the render fell through to `rows.length === 0`, and the parent was
 * told "No conversations yet." A routing mistake wearing the clothes of an
 * empty inbox. web/scripts/check-api-paths.mjs is the guard for that half.
 *
 * ── Class-targeted notices ────────────────────────────────────────────────
 *
 * This half was the server, and worse than the report suggested. The portal's
 * /announcements query was hand-written rather than calling
 * Announcement.audienceMatch(), and against the twelve notices below it
 * returned eleven of them: one archived, one expired, one not yet published, a
 * staff-only one, one for a class neither child is in, and one about another
 * family's child.
 *
 * It filtered on `classId`, and Announcement has no such field — the field is
 * `targetClasses`, an array — so that branch matched nothing and everything
 * was being decided by `audience: { $in: ["all","parents","students"] }`. With
 * `audience` defaulting to "all", that caught nearly every row regardless of
 * scope. The one shape it could not catch is audience:"class", which is what
 * the single-select class picker writes.
 *
 * Which is the reported failure precisely: the only notices a parent could not
 * see were the ones aimed at their child's class, and the ones they could see
 * included notices aimed at other people's children.
 *
 *   node scripts/check-portal-visibility.js
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
const note = (label) => console.log(`       ${label}`);

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
  const Message        = mongoose.model("Message");
  const Announcement   = mongoose.model("Announcement");
  const GuardianAccess = mongoose.model("GuardianAccess");

  await Promise.all([Conversation.init(), Message.init(), Announcement.init()]);

  // ── The cast, with the ids written out ───────────────────────────────────
  const SCHOOL  = "68c00000000000000000000a";
  const TEACHER = "usr-teacher";
  const BURSAR  = "usr-bursar";
  const CLASS_A = "cls-5a";
  const CLASS_B = "cls-5b";
  const CLASS_C = "cls-5c";
  const CHILD_1 = "stu-child-1";   // 5A
  const CHILD_2 = "stu-child-2";   // 5B
  const OTHER   = "stu-other";     // 5C, another family
  const PARENT  = "acc-parent";    // guardian of CHILD_1 and CHILD_2
  const STRANGER = "acc-stranger"; // guardian of OTHER only
  const HASH    = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";

  await School.create({
    _id: SCHOOL, name: "Geneva Bilingual Academy", email: "office@example.test",
    settings: { defaultLanguage: "en" },
  });
  await Class.create([
    { _id: CLASS_A, schoolId: SCHOOL, name: "Form 5A" },
    { _id: CLASS_B, schoolId: SCHOOL, name: "Form 5B" },
    { _id: CLASS_C, schoolId: SCHOOL, name: "Form 5C" },
  ]);
  await User.create([
    { _id: TEACHER, name: "Kuum Ernest", email: "t@example.test",
      password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true },
    { _id: BURSAR, name: "Ndi Grace", email: "b@example.test",
      password: "check-only-password", role: "bursar", schoolId: SCHOOL, isActive: true },
  ]);
  await Student.create([
    { _id: CHILD_1, userId: "usr-c1", schoolId: SCHOOL, classId: CLASS_A,
      studentName: "Bern Constance", enrollmentNo: "GVA-1", isActive: true, status: "approved" },
    { _id: CHILD_2, userId: "usr-c2", schoolId: SCHOOL, classId: CLASS_B,
      studentName: "Bern Emmanuel", enrollmentNo: "GVA-2", isActive: true, status: "approved" },
    { _id: OTHER, userId: "usr-o1", schoolId: SCHOOL, classId: CLASS_C,
      studentName: "Someone Else", enrollmentNo: "GVA-3", isActive: true, status: "approved" },
  ]);
  await GuardianAccess.create([
    { _id: PARENT, schoolId: SCHOOL, studentIds: [CHILD_1, CHILD_2], codeHash: HASH, codeHint: "11" },
    { _id: STRANGER, schoolId: SCHOOL, studentIds: [OTHER], codeHash: HASH, codeHint: "22" },
  ]);

  console.log("\n=== the records, as stored ===");
  note(`school        ${SCHOOL}`);
  note(`classes       5A=${CLASS_A}  5B=${CLASS_B}  5C=${CLASS_C}`);
  note(`teacher       ${TEACHER}`);
  note(`parent access ${PARENT}   studentIds=[${CHILD_1}, ${CHILD_2}]`);
  note(`  child 1     ${CHILD_1}  classId=${CLASS_A}`);
  note(`  child 2     ${CHILD_2}  classId=${CLASS_B}`);
  note(`stranger      ${STRANGER} studentIds=[${OTHER}]  (${OTHER} classId=${CLASS_C})`);

  const app  = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware", "auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const staffToken = (id, role) => jwt.sign(
    { id, role, schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  // A fresh token each call, which is what makes "reload" and "a new session"
  // the same thing here: nothing is carried between requests but the database.
  const portalToken = (accessId) => jwt.sign(
    { accessId, schoolId: SCHOOL }, process.env.JWT_SECRET,
    { audience: "portal", expiresIn: "1h" }
  );

  const call = async (token, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };

  const asTeacher = (m, u, b) => call(staffToken(TEACHER, "teacher"), m, u, b);
  const asBursar  = (m, u, b) => call(staffToken(BURSAR, "bursar"), m, u, b);
  const asParent  = (m, u, b) => call(portalToken(PARENT), m, u, b);
  const asStranger = (m, u, b) => call(portalToken(STRANGER), m, u, b);

  const listFor = async (who = asParent) => {
    const r = await who("GET", "/api/portal/messages/conversations");
    return { status: r.status, rows: r.body?.data ?? [], raw: r.body };
  };

  // ═════════════════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═════════════════════════════════════════════════════════════════════════

  // ── 1 & 3. Incoming, from a contact never opened ────────────────────────
  console.log("\n--- 1, 3: a message arrives from somebody never opened ---");
  let convTeacher = null;
  {
    const before = await listFor();
    note(`parent's list before anything: ${before.rows.length} row(s)`);
    if (before.rows.length === 0) ok("the list starts genuinely empty");
    else bad("the list starts empty", JSON.stringify(before.rows.map((r) => r._id)));

    const opened = await asTeacher("POST", "/api/messages/conversations/direct", {
      schoolId: SCHOOL, kind: "guardian", id: PARENT,
    });
    convTeacher = opened.body?.conversation?._id ?? opened.body?.data?._id ?? null;
    note(`teacher opened conversation ${convTeacher}`);

    const sent = await asTeacher("POST", `/api/messages/conversations/${convTeacher}/messages`, {
      schoolId: SCHOOL, body: "Constance did well today.",
    });
    note(`message id ${sent.body?.data?._id}  seq=${sent.body?.data?.seq}`);

    // What is actually in the database, and under which ids.
    const stored = await Conversation.findById(convTeacher).lean();
    note(`stored directKey    ${stored?.directKey}`);
    note(`stored participants ${JSON.stringify((stored?.participants ?? []).map((p) => `${p.kind}:${p.id}`))}`);
    note(`stored schoolId     ${stored?.schoolId} (type ${typeof stored?.schoolId})`);

    const guardianPart = (stored?.participants ?? []).find((p) => p.kind === "guardian");
    if (guardianPart && String(guardianPart.id) === PARENT) {
      ok("the guardian participant is the GuardianAccess id, not a student or a User id");
    } else {
      bad("the guardian is stored by their access id",
        `stored ${JSON.stringify(guardianPart)}, expected guardian:${PARENT}`);
    }

    // The parent has done nothing at all — not opened the contact, not
    // replied, not even looked.
    const after = await listFor();
    console.log("       raw response:");
    console.log(JSON.stringify(after.raw, null, 2).split("\n").map((l) => "         " + l).join("\n"));

    if (after.rows.length === 1 && String(after.rows[0]._id) === String(convTeacher)) {
      ok("the conversation is in the parent's list, unopened");
    } else {
      bad("an incoming message puts the conversation in the parent's list",
        `${after.rows.length} row(s): ${JSON.stringify(after.rows.map((r) => r._id))}`);
    }
    if (after.rows[0]?.unread === 1) ok("with one unread");
    else if (after.rows.length) bad("the unread count is 1", String(after.rows[0]?.unread));
  }

  // ── 2. Outgoing: the parent writes first ────────────────────────────────
  console.log("\n--- 2: the parent writes to somebody first ---");
  let convBursar = null;
  {
    const opened = await asParent("POST", "/api/portal/messages/conversations", {
      kind: "user", id: BURSAR,
    });
    convBursar = opened.body?.data?._id ?? null;
    note(`parent opened conversation ${convBursar} with ${BURSAR}`);

    const sent = await asParent("POST", `/api/portal/messages/conversations/${convBursar}`, {
      body: "Good morning, about the fees.",
    });
    if (sent.status < 400) ok("the parent's own message is accepted");
    else bad("the parent can send", `${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);

    const stored = await Message.findOne({ conversationId: convBursar }).lean();
    note(`sender stored as ${stored?.sender?.kind}:${stored?.sender?.id}`);
    if (stored && String(stored.sender?.id) === PARENT && stored.sender?.kind === "guardian") {
      ok("and is stored against their access id as a guardian");
    } else {
      bad("the parent's message records them as sender",
        JSON.stringify(stored?.sender));
    }

    const after = await listFor();
    if (after.rows.some((r) => String(r._id) === String(convBursar))) {
      ok("a thread the parent started is in their own list");
    } else {
      bad("an outgoing message puts the conversation in the list",
        JSON.stringify(after.rows.map((r) => r._id)));
    }
  }

  // ── 4. Reload ───────────────────────────────────────────────────────────
  console.log("\n--- 4: and after a reload ---");
  {
    // A brand new token, nothing cached, nothing in memory.
    const again = await listFor();
    if (again.rows.length === 2) ok("both conversations survive a fresh session");
    else bad("the list survives a reload", `${again.rows.length} row(s)`);
  }

  // ── 5. Several, newest first ────────────────────────────────────────────
  console.log("\n--- 5: several conversations, newest first ---");
  {
    // The bursar thread is currently the newer of the two. Move the teacher's
    // thread to the front by adding to it, and the order must follow.
    const before = (await listFor()).rows.map((r) => String(r._id));
    note(`order before: ${JSON.stringify(before)}`);

    await asTeacher("POST", `/api/messages/conversations/${convTeacher}/messages`, {
      schoolId: SCHOOL, body: "One more thing.",
    });

    const after = (await listFor()).rows;
    note(`order after:  ${JSON.stringify(after.map((r) => String(r._id)))}`);

    if (after.length === 2 && String(after[0]._id) === String(convTeacher)) {
      ok("the thread with the newest message is first");
    } else {
      bad("conversations are ordered by latest message",
        `first is ${after[0]?._id}, expected ${convTeacher}`);
    }

    const times = after.map((r) => String(r.lastMessageAt ?? ""));
    if (times[0] >= times[1]) ok("and lastMessageAt is descending");
    else bad("lastMessageAt descends", JSON.stringify(times));

    // Somebody else's threads are not in it.
    const theirs = await listFor(asStranger);
    if (theirs.rows.length === 0) ok("another family's list is still empty");
    else bad("conversations do not leak between families",
      JSON.stringify(theirs.rows.map((r) => r._id)));
  }

  // ── 6. The count and the list agree ─────────────────────────────────────
  console.log("\n--- 6: the badge and the list say the same thing ---");
  {
    const rows  = (await listFor()).rows;
    const fromList = rows.reduce((n, r) => n + (r.unread ?? 0), 0);

    const me = await asParent("GET", "/api/portal/me");
    const fromMe = me.body?.data?.unreadMessages ?? null;

    const notif = await asParent("GET", "/api/portal/notifications");
    const fromNotices = notif.body?.unread ?? null;

    note(`list=${fromList}  /me=${fromMe}  /notifications=${fromNotices}`);
    if (fromList === fromMe && fromMe === fromNotices) {
      ok(`all three agree on ${fromList} unread`);
    } else {
      bad("the three unread counts agree",
        `list ${fromList}, /me ${fromMe}, /notifications ${fromNotices}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CLASS-TARGETED NOTICES
  // ═════════════════════════════════════════════════════════════════════════

  const announcements = async (who = asParent, studentId) => {
    const url = "/api/portal/announcements" + (studentId ? `?studentId=${studentId}` : "");
    const r = await who("GET", url);
    return { status: r.status, rows: r.body?.data ?? [], raw: r.body };
  };
  const titles = (rows) => rows.map((a) => a.title);

  const mk = (id, extra) => Announcement.create({
    _id: id, schoolId: SCHOOL, title: id, body: "…",
    authorRole: "school_admin", ...extra,
  });

  console.log("\n--- the notices, as stored ---");
  await mk("all-school",      { audience: "all" });
  await mk("parents-only",    { audiences: ["parents"] });
  await mk("teachers-only",   { audiences: ["teachers"] });
  await mk("class-5a-legacy", { audience: "class", targetClasses: [CLASS_A] });
  await mk("class-5b-new",    { audiences: ["parents"], targetClasses: [CLASS_B] });
  await mk("class-5c-only",   { audiences: ["parents"], targetClasses: [CLASS_C] });
  await mk("class-5b-and-5c", { audiences: ["parents"], targetClasses: [CLASS_B, CLASS_C] });
  await mk("child-1-only",    { audiences: ["parents"], targetStudents: [CHILD_1] });
  await mk("other-child-only",{ audiences: ["parents"], targetStudents: [OTHER] });
  await mk("expired",         { audience: "all", expiresAt: new Date(Date.now() - 86400000) });
  await mk("scheduled",       { audience: "all", publishAt: new Date(Date.now() + 86400000) });
  await mk("archived",        { audience: "all", isActive: false });

  for (const a of await Announcement.find({ schoolId: SCHOOL }).lean()) {
    note(`${String(a._id).padEnd(17)} audience=${String(a.audience).padEnd(9)} ` +
         `audiences=${JSON.stringify(a.audiences ?? null).padEnd(13)} ` +
         `targetClasses=${JSON.stringify(a.targetClasses ?? [])} ` +
         `targetStudents=${JSON.stringify(a.targetStudents ?? [])}`);
  }

  // ── 1 & 2. Any child in a targeted class ────────────────────────────────
  console.log("\n--- 1, 2: a notice for 5B, and this parent's second child is in 5B ---");
  {
    const r = await announcements();
    console.log("       raw response:");
    console.log(JSON.stringify(r.raw, null, 2).split("\n").slice(0, 24)
      .map((l) => "         " + l).join("\n"));
    note(`titles: ${JSON.stringify(titles(r.rows))}`);

    // The reported failure. The token resolves CHILD_1 (5A) first, so under
    // the old query this was decided entirely by 5A — and could not have
    // matched even then, because it filtered a field that does not exist.
    if (titles(r.rows).includes("class-5b-new")) {
      ok("the 5B notice reaches the parent, via their child in 5B");
    } else {
      bad("a notice for any child's class reaches the parent",
        `5B notice absent. Child 2 (${CHILD_2}) is in ${CLASS_B}.\n` +
        `This is the reported failure.`);
    }

    if (titles(r.rows).includes("class-5a-legacy")) {
      ok("and so does the 5A one, written in the older shape");
    } else {
      bad("a legacy audience:\"class\" notice reaches the parent", "5A notice absent");
    }

    if (titles(r.rows).includes("class-5b-and-5c")) {
      ok("a notice naming several classes matches on any one of them");
    } else {
      bad("a multi-class notice matches on any class", "5B+5C notice absent");
    }
  }

  // ── 3. No child in the class ────────────────────────────────────────────
  console.log("\n--- 3: and a notice for a class none of their children are in ---");
  {
    const r = await announcements();
    if (!titles(r.rows).includes("class-5c-only")) {
      ok("the 5C notice does not reach them");
    } else {
      bad("a notice for an unrelated class is withheld",
        "5C notice present; this parent has nobody in 5C");
    }

    // And the reverse, so the assertion above is not passing because nothing
    // matches anything.
    const theirs = await announcements(asStranger);
    note(`stranger's titles: ${JSON.stringify(titles(theirs.rows))}`);
    if (titles(theirs.rows).includes("class-5c-only")) {
      ok("and does reach the family whose child IS in 5C");
    } else {
      bad("the 5C notice reaches the 5C family", JSON.stringify(titles(theirs.rows)));
    }
    if (!titles(theirs.rows).includes("class-5a-legacy") &&
        !titles(theirs.rows).includes("class-5b-new")) {
      ok("who in turn see neither the 5A nor the 5B notice");
    } else {
      bad("notices do not leak to the wrong class", JSON.stringify(titles(theirs.rows)));
    }
  }

  // ── 5. School-wide ──────────────────────────────────────────────────────
  console.log("\n--- 5: school-wide notices reach everyone ---");
  {
    const mine   = titles((await announcements()).rows);
    const theirs = titles((await announcements(asStranger)).rows);

    if (mine.includes("all-school") && theirs.includes("all-school")) {
      ok("the audience:\"all\" notice reaches both families");
    } else {
      bad("a school-wide notice reaches everyone",
        `mine=${mine.includes("all-school")} theirs=${theirs.includes("all-school")}`);
    }
    if (mine.includes("parents-only") && theirs.includes("parents-only")) {
      ok("and so does the unscoped audiences:[\"parents\"] one");
    } else {
      bad("an unscoped parents notice reaches every parent", JSON.stringify({ mine, theirs }));
    }

    // The leak the old query had: `audience` defaults to "all", so a row
    // written as audiences:["teachers"] still has audience:"all" underneath
    // and matched the first branch of the old $or.
    if (!mine.includes("teachers-only")) {
      ok("a staff-only notice does NOT reach a parent");
    } else {
      bad("audiences:[\"teachers\"] is withheld from parents",
        "The old query matched it through the audience:\"all\" default.");
    }
  }

  // ── 6. One named pupil ──────────────────────────────────────────────────
  console.log("\n--- 6: a notice about one named pupil ---");
  {
    const mine   = titles((await announcements()).rows);
    const theirs = titles((await announcements(asStranger)).rows);

    if (mine.includes("child-1-only")) ok("reaches the guardian of that pupil");
    else bad("a student-targeted notice reaches their guardian", JSON.stringify(mine));

    if (!theirs.includes("child-1-only")) ok("and nobody else");
    else bad("a student-targeted notice is withheld from other families", JSON.stringify(theirs));

    if (!mine.includes("other-child-only")) ok("and this parent does not see another pupil's");
    else bad("another pupil's notice is withheld", JSON.stringify(mine));
  }

  // ── 7. Selected child must not narrow the list ──────────────────────────
  console.log("\n--- 7: switching child must not change what is visible ---");
  {
    // The heart of the reported bug: /portal/me and every other endpoint
    // resolve ONE child from the token, and the notice list used that child's
    // class. A parent looking at Child 1 could not see Child 2's notices, and
    // had no reason to think switching would reveal any.
    const onChild1 = titles((await announcements(asParent, CHILD_1)).rows).sort();
    const onChild2 = titles((await announcements(asParent, CHILD_2)).rows).sort();
    note(`viewing child 1: ${JSON.stringify(onChild1)}`);
    note(`viewing child 2: ${JSON.stringify(onChild2)}`);

    if (String(onChild1) === String(onChild2)) {
      ok("the same notices whichever child is selected");
    } else {
      bad("the notice list does not depend on the selected child",
        `child 1 sees ${onChild1.length}, child 2 sees ${onChild2.length}\n` +
        `only in child 1: ${onChild1.filter((x) => !onChild2.includes(x))}\n` +
        `only in child 2: ${onChild2.filter((x) => !onChild1.includes(x))}`);
    }
    if (onChild1.includes("class-5a-legacy") && onChild1.includes("class-5b-new")) {
      ok("and both children's class notices are in it either way");
    } else {
      bad("both classes are represented", JSON.stringify(onChild1));
    }
  }

  // ── The comparison itself ───────────────────────────────────────────────
  console.log("\n--- ids compare as strings, whatever the caller holds ---");
  {
    // Class._id is a String UUID here, but audienceMatch is called from more
    // than one place and a caller holding an ObjectId, or a populated Class
    // document, would otherwise build a filter that matches nothing — which
    // looks exactly like "there are no notices".
    const oid = new mongoose.Types.ObjectId();
    const asObjectId = Announcement.audienceMatch({
      audience: "parents", classIds: [oid],
    });
    const flat = JSON.stringify(asObjectId);
    if (flat.includes(String(oid)) && !flat.includes("buffer")) {
      ok("an ObjectId is serialised to its hex string");
    } else {
      bad("ObjectIds are normalised", flat.slice(0, 200));
    }

    const populated = Announcement.audienceMatch({
      audience: "parents", classIds: [{ _id: CLASS_B, name: "Form 5B" }],
    });
    if (JSON.stringify(populated).includes(CLASS_B)) {
      ok("and a populated document by its _id");
    } else {
      bad("a populated reference is normalised", JSON.stringify(populated).slice(0, 200));
    }

    // Same result either way, against real rows.
    const byString = await Announcement.countDocuments({
      schoolId: SCHOOL, $or: Announcement.audienceMatch({ audience: "parents", classIds: [CLASS_B] }),
    });
    const byPopulated = await Announcement.countDocuments({
      schoolId: SCHOOL,
      $or: Announcement.audienceMatch({
        audience: "parents", classIds: [{ _id: CLASS_B }],
      }),
    });
    if (byString === byPopulated && byString > 0) {
      ok(`both forms select the same ${byString} rows`);
    } else {
      bad("both forms select the same rows", `string ${byString}, populated ${byPopulated}`);
    }

    // The single-classId form still works — the student feed passes one.
    const single = Announcement.audienceMatch({ audience: "students", classId: CLASS_A });
    if (JSON.stringify(single).includes(CLASS_A)) ok("and the single classId caller is unbroken");
    else bad("audienceMatch still accepts one classId", JSON.stringify(single).slice(0, 200));
  }

  // ── Scheduling and lifecycle ────────────────────────────────────────────
  console.log("\n--- and a notice has to be live to be shown ---");
  {
    const mine = titles((await announcements()).rows);
    for (const [name, why] of [
      ["expired",   "past its expiresAt"],
      ["scheduled", "not yet published"],
      ["archived",  "isActive false"],
    ]) {
      if (!mine.includes(name)) ok(`a notice ${why} is not shown`);
      else bad(`a notice ${why} is withheld`,
        `"${name}" reached the parent. The old query checked none of these.`);
    }
  }

  await server.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
