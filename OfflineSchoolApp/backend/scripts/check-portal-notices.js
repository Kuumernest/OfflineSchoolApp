// backend/scripts/check-portal-notices.js
"use strict";

/**
 * What a parent is told, and whether they can still be told it tomorrow.
 *
 * Three failures reported from a phone: a message to a parent raised no
 * notification, a gate scan raised none either, and a new thread was missing
 * from the Messages screen until the parent opened that contact by name.
 *
 * ── The rule these assertions are written to ──────────────────────────────
 *
 * The stored record is the source of truth, and delivery is a separate job
 * that is allowed to fail. This system already half-believes that: the
 * Notification collection is a queue with a channel, an attempt count and a
 * backoff precisely so that taking a fee payment cannot fail because a mail
 * server is down.
 *
 * Where it stopped believing it is the parent's own inbox. Two places:
 *
 *   • the portal's notification list filtered on `status`, so a notification
 *     for a family with no email address on file — recorded as "skipped",
 *     because nothing was attempted and retrying cannot help — was hidden
 *     from the one surface that needs no email at all.
 *
 *   • the gate created no record whatsoever for an on-time arrival. The
 *     reasoning for not EMAILING those is sound and is kept: a school of 500
 *     scanning twice a day is 20,000 messages a month, and after a week
 *     "arrived 07:42" is noise that buries the message that mattered. But not
 *     sending an email is a delivery decision, and it had been implemented as
 *     a decision not to remember.
 *
 * So: every scan is recorded, the exceptions policy still governs what gets
 * emailed, and the portal shows what was recorded.
 *
 * The seven scenarios below are the reported ones, plus the ones that share
 * their shape — offline, closed, never-opened, and a dead transport.
 *
 *   node scripts/check-portal-notices.js
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
  // No SMTP configured, which is the point of scenario 6 and also the ordinary
  // state of a school that has not bought a mail plan. The channel resolves to
  // "log" and nothing leaves the building.
  delete process.env.SMTP_HOST;

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User           = mongoose.model("User");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const School         = mongoose.model("School");
  const Conversation   = mongoose.model("Conversation");
  const Notification   = mongoose.model("Notification");
  const GateEvent      = mongoose.model("GateEvent");
  const GuardianAccess = mongoose.model("GuardianAccess");

  await Promise.all([Conversation.init(), Notification.init(), GateEvent.init()]);

  const SCHOOL  = "68c000000000000000000009";
  const TEACHER = "usr-teacher";
  const MOTHER  = "acc-mother";
  const FATHER  = "acc-father";
  const STUDENT = "stu-john";
  const HASH    = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";

  await School.create({
    _id: SCHOOL, name: "Geneva Bilingual Academy", email: "office@example.test",
    settings: { defaultLanguage: "en" },   // gateNotify left unset: the default
  });

  await User.create({
    _id: TEACHER, name: "Kuum Ernest", email: "t@example.test",
    password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1" });

  // No guardianEmail and no guardianPhone, which is the reported school's
  // actual state and the case the whole audit turns on: there is no address to
  // deliver to, and the portal needs none.
  await Student.create({
    _id: STUDENT, userId: "usr-stu-john", schoolId: SCHOOL, classId: "cls-1",
    studentName: "John Doe", enrollmentNo: "GVA00-2026-0007",
    isActive: true, status: "approved", gateToken: "gate-token-john",
  });

  // Two guardians, one child. Both hold their own code, so a notice that is
  // routed by access row rather than by child would reach one of them.
  await GuardianAccess.create({
    _id: MOTHER, schoolId: SCHOOL, studentIds: [STUDENT], codeHash: HASH, codeHint: "11",
  });
  await GuardianAccess.create({
    _id: FATHER, schoolId: SCHOOL, studentIds: [STUDENT], codeHash: HASH, codeHint: "22",
  });

  const app  = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware", "auth"));
  app.use("/api/gate",     auth.authenticate, require(path.join(SRC, "routes/gate.routes")));
  app.use("/api/messages", auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const staffToken = jwt.sign(
    { id: TEACHER, role: "teacher", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  const portalToken = (accessId) => jwt.sign(
    { accessId, schoolId: SCHOOL },
    process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" }
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
  const staff  = (m, u, b) => call(staffToken, m, u, b);
  const mother = (m, u, b) => call(portalToken(MOTHER), m, u, b);
  const father = (m, u, b) => call(portalToken(FATHER), m, u, b);

  const notices = async (who = mother) => {
    const r = await who("GET", "/api/portal/notifications");
    return r.body?.data ?? [];
  };

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIOS 1, 3 and 7 — a message to a parent who is not there
  // ═════════════════════════════════════════════════════════════════════════
  //
  // One exchange covers all three: the parent has never opened a thread with
  // this teacher (3), holds no session while it is sent (1), and reads it on a
  // later, separate session (7). Nothing here is polled or pushed — the state
  // is fetched on load, which is what makes those three the same test.
  console.log("\n--- a teacher writes to a parent who is not looking (1, 3, 7) ---");

  let convId = null;
  {
    const before = await mother("GET", "/api/portal/messages/conversations");
    if ((before.body?.data ?? []).length === 0) {
      ok("the parent starts with no threads at all, having never opened one");
    } else {
      bad("the parent starts with no threads", JSON.stringify(before.body?.data));
    }

    const opened = await staff("POST", "/api/messages/conversations/direct", {
      schoolId: SCHOOL, kind: "guardian", id: MOTHER,
    });
    convId = opened.body?.conversation?._id ?? opened.body?.data?._id ?? null;

    const sent = await staff("POST", `/api/messages/conversations/${convId}/messages`, {
      schoolId: SCHOOL, body: "Please come in on Thursday.",
    });
    if (sent.status < 400) ok("the teacher's message is accepted and stored");
    else bad("the message is stored", `${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);

    // A brand new session, as if the parent had just signed in on a phone that
    // was switched off while all of the above happened.
    const list = await mother("GET", "/api/portal/messages/conversations");
    const rows = list.body?.data ?? [];

    if (rows.length === 1) {
      ok("and on their next sign-in the thread is simply there");
    } else {
      bad("the thread is in the parent's list without them opening the contact",
        `${rows.length} thread(s).\n` +
        `Reported: "new chats are missing until the parent opens the contact".`);
    }

    if (rows[0]?.unread === 1) ok("counted unread, so it draws the eye");
    else if (rows.length) bad("the unread count is 1", String(rows[0]?.unread));

    if (rows[0]?.lastMessagePreview) ok("and previews what was said");
    else if (rows.length) bad("the row previews the message", JSON.stringify(rows[0]?.lastMessagePreview));

    // Ordering. A second thread with a newer message has to come first, or a
    // parent with a term's worth of threads never sees the new one.
    const second = await staff("POST", "/api/messages/conversations/direct", {
      schoolId: SCHOOL, kind: "guardian", id: FATHER,
    });
    const secondId = second.body?.conversation?._id ?? null;
    await staff("POST", `/api/messages/conversations/${secondId}/messages`, {
      schoolId: SCHOOL, body: "And a word about fees.",
    });
    const fatherRows = (await father("GET", "/api/portal/messages/conversations")).body?.data ?? [];
    if (fatherRows.length === 1 && String(fatherRows[0]._id) === String(secondId)) {
      ok("the second guardian's own thread is their own, not the mother's");
    } else {
      bad("each guardian sees their own thread",
        `${fatherRows.length} row(s): ${JSON.stringify(fatherRows.map((r) => r._id))}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — the same message, while the parent IS looking
  // ═════════════════════════════════════════════════════════════════════════
  //
  // There is no socket layer in this system and this suite does not pretend
  // otherwise. What "immediately" can mean here is that the next read returns
  // it with no other step in between — no opening the contact, no cache to
  // clear, nothing to invalidate. That is what is asserted.
  console.log("\n--- and while the parent is holding the screen (2) ---");
  {
    const seen = (await mother("GET", "/api/portal/messages/conversations")).body?.data ?? [];
    const wasUnread = seen[0]?.unread ?? 0;

    await mother("POST", `/api/portal/messages/conversations/${convId}/read`, {
      seq: seen[0]?.lastMessageSeq ?? 1,
    });

    await staff("POST", `/api/messages/conversations/${convId}/messages`, {
      schoolId: SCHOOL, body: "Thursday at ten, if that suits.",
    });

    const after = (await mother("GET", "/api/portal/messages/conversations")).body?.data ?? [];
    if ((after[0]?.unread ?? 0) >= 1) {
      ok(`the next read of the list carries the new message unread (was ${wasUnread})`);
    } else {
      bad("a new message raises the unread count again", String(after[0]?.unread));
    }
    if (/Thursday at ten/.test(String(after[0]?.lastMessagePreview ?? ""))) {
      ok("and the preview is the newest message, not the first");
    } else {
      bad("the preview follows the newest message", JSON.stringify(after[0]?.lastMessagePreview));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // An incoming message has to be VISIBLE, not merely present
  // ═════════════════════════════════════════════════════════════════════════
  //
  // A thread in a list the parent has to think to open is not a notification.
  // The reported failure was "no visible notification", and the portal's
  // notice list is where a parent looks for one.
  //
  // Not by writing message bodies into the Notification queue: that queue has
  // a channel and a retry backoff, so a row in it is an email or an SMS
  // actually going out, and one per message on a live thread is the noise
  // problem again. Derived, server-side, from the conversations already
  // stored — one entry per thread, because a thread with nine unread is one
  // thing to go and read.
  console.log("\n--- an unread thread is a notice a parent can see ---");
  {
    const rows = await notices();
    const msg  = rows.filter((n) => n.kind === "message");

    if (msg.length === 1) {
      ok("the unread thread appears in the notice list");
    } else {
      bad("an unread thread appears among the notices",
        `${msg.length} message notice(s) of ${rows.length} row(s).\n` +
        `Reported: "incoming messages do not generate visible notifications".`);
    }

    if (msg[0]?.conversationId && String(msg[0].conversationId) === String(convId)) {
      ok("and points at the thread, so the notice can be opened");
    } else if (msg.length) {
      bad("the notice names its conversation", JSON.stringify(msg[0]?.conversationId));
    }

    if (msg[0]?.unread >= 1) ok("carrying how many are unread");
    else if (msg.length) bad("the notice carries the unread count", String(msg[0]?.unread));

    if (/Thursday at ten/.test(String(msg[0]?.body ?? ""))) {
      ok("and the newest line, so it reads without being opened");
    } else if (msg.length) {
      bad("the notice shows the newest message", JSON.stringify(msg[0]?.body));
    }

    // The count a badge would use. Without it every client has to fetch the
    // conversation list and add up, which is how one of them ends up not
    // bothering.
    const r = await mother("GET", "/api/portal/notifications");
    if ((r.body?.unread ?? 0) >= 1) ok("and the endpoint totals the unread, for a badge");
    else bad("the endpoint reports a total unread count", JSON.stringify(r.body?.unread));
  }

  // ── And it goes away when they have read it ─────────────────────────────
  //
  // A badge that does not clear is worse than no badge: it stops meaning
  // anything within a day and then the parent ignores it on the day it
  // matters. The notice is derived from the read marker, so this is really a
  // test that the marker moves and that both surfaces read the same one.
  console.log("\n--- and clears when the parent has read it ---");
  {
    const thread = await mother("GET", `/api/portal/messages/conversations/${convId}`);
    const newest = (thread.body?.data?.messages ?? []).reduce(
      (max, m) => Math.max(max, m.seq ?? 0), 0
    );

    const marked = await mother("POST", `/api/portal/messages/conversations/${convId}/read`, {
      seq: newest,
    });
    if (marked.status < 400) ok(`the read marker moves to seq ${newest}`);
    else bad("the read marker moves", `${marked.status} ${JSON.stringify(marked.body).slice(0, 160)}`);

    const rows = await notices();
    if (!rows.some((n) => n.kind === "message")) {
      ok("the message notice is gone");
    } else {
      bad("a read thread raises no notice",
        JSON.stringify(rows.filter((n) => n.kind === "message").map((n) => n.unread)));
    }

    const r = await mother("GET", "/api/portal/notifications");
    if ((r.body?.unread ?? 0) === 0) ok("and the total is back to zero");
    else bad("the unread total clears", JSON.stringify(r.body?.unread));

    // The same number, from the endpoint every screen loads. Two counts that
    // can disagree is a badge that contradicts the list under it.
    const me = await mother("GET", "/api/portal/me");
    if ((me.body?.data?.unreadMessages ?? null) === 0) {
      ok("and /me agrees, which is what the tab badge reads");
    } else {
      bad("/me reports the same count", JSON.stringify(me.body?.data?.unreadMessages));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIOS 4, 5 and 6 — the gate
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- John Doe arrives, on time (4) ---");

  // shouldNotify reads getHours() off the scan time, and that is LOCAL. So
  // these are built in local terms. An ISO string that looks like it says "on
  // time" means something else three time zones away, and this suite got that
  // wrong on its first run: 07:42Z ran as 08:42, which is late, and an
  // assertion about on-time behaviour passed for entirely the wrong reason.
  const localTime = (h, m, day = 8) => new Date(2026, 8, day, h, m, 0).toISOString();

  const scan = (at) => staff("POST", "/api/gate/scan", {
    schoolId: SCHOOL, token: "gate-token-john", at,
  });

  {
    const r = await scan(localTime(7, 20));   // before the 07:45 default

    if (r.status < 400 && r.body?.direction === "in") ok("the scan is recorded as an arrival");
    else bad("the scan is recorded", `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);

    if (await GateEvent.countDocuments({ schoolId: SCHOOL, studentId: STUDENT, direction: "in" })) {
      ok("the attendance event is persisted");
    } else {
      bad("the gate event is persisted", "no GateEvent row");
    }

    // The delivery decision is unchanged and must stay unchanged: an on-time
    // arrival is not emailed. Read off the policy the route returns, not off
    // `notified` — that is also false when there was simply no address, and
    // conflating the two is how "we chose not to" reads as "we could not".
    if (r.body?.notifyPolicy?.notify === false) {
      ok(`and no email is sent for an on-time arrival — as before ("${r.body.notifyPolicy.reason}")`);
    } else {
      bad("an on-time arrival sends no email", JSON.stringify(r.body?.notifyPolicy));
    }

    const rows = await notices();
    const arrival = rows.find((n) => n.kind === "gate.arrival");

    if (arrival) {
      ok("but the parent has a notice about it");
    } else {
      bad("the parent is notified of the arrival",
        `kinds present: ${[...new Set(rows.map((n) => n.kind))].join(", ") || "none"}.\n` +
        `Reported: "gate attendance scans do not notify parents".`);
    }

    // The wording the report asked for, and the two facts inside it.
    const text = String(arrival?.body ?? "");
    if (/John Doe/.test(text)) ok("naming the child");
    else if (arrival) bad("the notice names the child", JSON.stringify(text.slice(0, 120)));

    if (/07:20/.test(text)) ok("with the time they came through");
    else if (arrival) bad("the notice carries the time", JSON.stringify(text.slice(0, 120)));

    // body is the rendered HTML e-mail. A phone puts it in a Text node, so an
    // unprocessed shell shows the reader its own markup.
    if (arrival && !/<[a-z]/i.test(text)) {
      ok("as text a phone can render, not an email shell");
    } else if (arrival) {
      bad("the notice body is renderable text", `starts: ${JSON.stringify(text.slice(0, 80))}`);
    }

    // Routed by child, so every guardian of that child sees it. Delivery
    // reaches one address; the portal needs no address at all.
    const forFather = (await notices(father)).find((n) => n.kind === "gate.arrival");
    if (forFather) ok("and so does the child's other guardian");
    else bad("every guardian of the child sees the arrival", "the father's list has none");
  }

  console.log("\n--- and leaves at the normal time (5) ---");
  {
    const r = await scan(localTime(15, 10));   // after the 14:00 default

    if (r.body?.direction === "out") ok("the scan is recorded as a departure");
    else bad("the scan is a departure", JSON.stringify(r.body?.direction));

    if (r.body?.notifyPolicy?.notify === false) {
      ok(`no email for a normal departure — as before ("${r.body.notifyPolicy.reason}")`);
    } else {
      bad("a normal departure sends no email", JSON.stringify(r.body?.notifyPolicy));
    }

    const departure = (await notices()).find((n) => n.kind === "gate.departure");
    if (departure) ok("and the parent has a notice for it too");
    else bad("the parent is notified of the departure", "no gate.departure notice");

    if (/15:10/.test(String(departure?.body ?? ""))) ok("with the time they left");
    else if (departure) bad("the departure notice carries the time", JSON.stringify(departure?.body));
  }

  console.log("\n--- an exception is still an exception (6, and the policy is not lost) ---");
  {
    // A late arrival, the next day so direction derives afresh. This is the
    // message the exceptions policy exists to let through, and recording every
    // scan must not have flattened the distinction between the two.
    const r = await scan(localTime(9, 30, 9));

    if (r.body?.notifyPolicy?.notify === true) {
      ok(`a late arrival is still marked for delivery ("${r.body.notifyPolicy.reason}")`);
    } else {
      bad("a late arrival is marked for delivery", JSON.stringify(r.body?.notifyPolicy));
    }

    const late = await Notification.findOne({
      schoolId: SCHOOL, studentId: STUDENT, kind: "gate.arrival",
      "data.reason": "arrived late",
    }).lean();

    if (late) ok("and the record says which scan it was");
    else bad("the late arrival is recorded with its reason", "no row carrying data.reason");

    // The two reasons a message did not go are different answers to a parent
    // asking why, and the record has to tell them apart: "we do not send those"
    // is not "we had nowhere to send it".
    if (late && /address|email/i.test(String(late.skipReason ?? ""))) {
      ok("skipped for want of an address, not for want of interest");
    } else if (late) {
      bad("the skip reason distinguishes the two cases",
        JSON.stringify({ status: late.status, skipReason: late.skipReason }));
    }
  }

  console.log("\n--- with nothing able to deliver anything (6) ---");
  {
    // Every notice above was raised with no SMTP host, no guardian email and
    // no guardian phone. Nothing could have been delivered by any channel, and
    // the whole point is that the parent is told regardless.
    const stored = await Notification.find({ schoolId: SCHOOL, studentId: STUDENT }).lean();
    const delivered = stored.filter((n) => n.status === "sent");

    if (stored.length >= 2 && delivered.length === 0) {
      ok(`${stored.length} notices are stored and ${delivered.length} were delivered`);
    } else {
      bad("notices are stored even when nothing can be delivered",
        `${stored.length} stored, ${delivered.length} sent`);
    }

    // And they survive a reload, because they are rows and not state.
    const reread = await notices();
    if (reread.some((n) => n.kind === "gate.arrival") &&
        reread.some((n) => n.kind === "gate.departure")) {
      ok("and both are still there on a fresh session — the record is the truth");
    } else {
      bad("the notices survive a new session",
        `kinds: ${[...new Set(reread.map((n) => n.kind))].join(", ")}`);
    }

    // The skip is still recorded honestly. A parent asking "why was I not
    // emailed" has an answer, and it is not "you were".
    const skipped = stored.filter((n) => n.status === "skipped" && n.skipReason);
    if (skipped.length) ok(`and each says why it was not sent ("${skipped[0].skipReason}")`);
    else bad("a notice that was not delivered says why", JSON.stringify(stored.map((n) => n.status)));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The allowlist. Not to be widened by accident.
  // ═════════════════════════════════════════════════════════════════════════
  //
  // `body` is a rendered message the pipeline sent, and for an admin welcome or
  // a password reset it contains a temporary password. The portal list is an
  // allowlist by name for that reason, and adding "message" to it must not
  // have turned it into a blocklist.
  console.log("\n--- and a parent is still shown only what they may see ---");
  {
    await Notification.create({
      _id: "notif-secret", schoolId: SCHOOL, studentId: STUDENT,
      kind: "test", to: "someone@example.test", channel: "log",
      subject: "Your temporary password", body: "The password is hunter2",
      status: "sent",
    });

    const rows = await notices();
    if (!rows.some((n) => n._id === "notif-secret")) {
      ok("a kind not on the list is not shown, even with status sent");
    } else {
      bad("the notice list is an allowlist", "an unlisted kind reached the parent");
    }

    const src = require("fs").readFileSync(path.join(SRC, "routes/portal.routes.js"), "utf8");
    if (/kind:\s*\{\s*\$in:/.test(src) && !/\$nin:/.test(src)) {
      ok("and it is expressed as $in, never $nin");
    } else {
      bad("the kind filter is an allowlist", "found a $nin in portal.routes.js");
    }

    // Another child's notices are another child's.
    await Student.create({
      _id: "stu-other", userId: "usr-other", schoolId: SCHOOL, classId: "cls-1",
      studentName: "Someone Else", enrollmentNo: "GVA00-2026-0008",
      isActive: true, status: "approved",
    });
    await Notification.create({
      _id: "notif-other", schoolId: SCHOOL, studentId: "stu-other",
      kind: "gate.arrival", to: "—", channel: "log",
      subject: "Arrived at school", body: "Someone Else arrived at school at 07:50.",
      status: "skipped", skipReason: "No email address on file",
    });

    const rows2 = await notices();
    if (!rows2.some((n) => n._id === "notif-other")) {
      ok("and another child's arrival is not in this parent's list");
    } else {
      bad("notices are scoped to the caller's child", "another child's notice was returned");
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // An absence, which nothing used to tell anybody about
  // ═════════════════════════════════════════════════════════════════════════
  //
  // `attendance.absent` was in the Notification enum, its template was written
  // in both languages, and the portal's allowlist would have shown it — and no
  // code path created one. So a child was marked absent and their parent was
  // told nothing: no email, no SMS, and nothing in the portal. It was the only
  // one of the four producerless kinds where the fact was unreachable by any
  // other route.
  console.log("\n--- a child is marked absent ---");
  {
    app.use("/api/attendance", auth.authenticate,
      require(path.join(SRC, "routes/attendance.routes")));

    const DAY = "2026-09-08";
    const mark = (status, periodId) => staff("POST", "/api/attendance/students/bulk", {
      schoolId: SCHOOL, classId: "cls-1", date: DAY, periodId,
      records: [{ studentId: STUDENT, status }],
    });

    const r = await mark("absent", "per-1");
    if (r.status < 400 && r.body?.saved === 1) ok("the register saves");
    else bad("the register saves", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const rows = await notices();
    const absent = rows.filter((n) => n.kind === "attendance.absent");
    if (absent.length === 1) ok("and the parent is told");
    else bad("the parent is told about an absence",
      `${absent.length} absence notice(s); kinds: ${[...new Set(rows.map((n) => n.kind))].join(", ")}`);

    if (/John Doe/.test(String(absent[0]?.body ?? ""))) ok("by name");
    else if (absent.length) bad("the notice names the child", JSON.stringify(absent[0]?.body));

    // One per child per day. A pupil away all day is six or eight absences in
    // the register and one thing to tell a parent.
    await mark("absent", "per-2");
    await mark("absent", "per-3");
    const after = (await notices()).filter((n) => n.kind === "attendance.absent");
    if (after.length === 1) ok("three periods of absence are still one notice");
    else bad("absences are deduped per child per day", `${after.length} notices`);

    const stored = await Notification.findOne({
      schoolId: SCHOOL, kind: "attendance.absent", studentId: STUDENT,
    }).lean();
    if (String(stored?._id) === `absent:${SCHOOL}:${STUDENT}:${DAY}`) {
      ok("keyed on the child and the day, so a replayed sync is free");
    } else {
      bad("the notice id is derived from child and date", String(stored?._id));
    }

    // Unlike an on-time gate arrival, an absence is meant to be sent. Here
    // there is no address, so it is skipped for that reason and not by policy.
    if (/address/i.test(String(stored?.skipReason ?? ""))) {
      ok("and queued for delivery, not withheld by policy");
    } else {
      bad("an absence is queued for delivery",
        JSON.stringify({ status: stored?.status, skipReason: stored?.skipReason }));
    }

    // Marking somebody present must not raise one.
    await mark("present", "per-4");
    const still = (await notices()).filter((n) => n.kind === "attendance.absent");
    if (still.length === 1) ok("and marking a pupil present raises nothing");
    else bad("only an absence notifies", `${still.length} notices after a present mark`);
  }

  // =========================================================================
  // The notices badge, and what "read" means
  // =========================================================================
  //
  // A message thread carries a read marker per participant, so unread messages
  // were already arithmetic. Notices had nothing of the kind.
  //
  // The first attempt was one timestamp on the access row, moved when the list
  // was opened. That cleared the whole tab the moment a parent glanced at it,
  // which is not what "read" means when four notices arrived and they looked
  // at one. Receipts are per notice now, keyed by GuardianAccess — the same
  // shape Announcement.readBy has, for a different kind of reader.
  console.log("\n--- the notices badge counts what has not been read ---");
  {
    // Back to "never looked". noticesSeenAt is the floor for whatever the old
    // whole-tab behaviour already cleared, and this suite has moved it.
    await GuardianAccess.updateOne({ _id: MOTHER, schoolId: SCHOOL },
      { $set: { noticesSeenAt: null } });
    await Notification.updateMany({ schoolId: SCHOOL }, { $set: { readBy: [] } });

    const rows  = (await notices()).filter((n) => n.kind !== "message");
    const fresh = await mother("GET", "/api/portal/me");
    const count = fresh.body?.data?.unreadNotices ?? null;

    if (count === rows.length && count > 0) {
      ok(`/me counts ${count} unread notices, matching the list`);
    } else {
      bad("/me counts the unread notices", `/me ${count}, list ${rows.length}`);
    }

    // The whole point of the change: reading the LIST marks nothing.
    await mother("GET", "/api/portal/notifications");
    const after = await mother("GET", "/api/portal/me");
    if ((after.body?.data?.unreadNotices ?? null) === count) {
      ok("opening the list marks nothing — the count is unchanged");
    } else {
      bad("the list does not clear the badge",
        `was ${count}, now ${after.body?.data?.unreadNotices}`);
    }

    if (rows.every((n) => n.read === false)) ok("and every card reports itself unread");
    else bad("each row carries its own read state", JSON.stringify(rows.map((n) => n.read)));

    // One card, tapped.
    const target = rows[0];
    const marked = await mother("POST", `/api/portal/notifications/${target._id}/read`);
    if (marked.status === 200) ok("one notice can be marked read");
    else bad("a notice can be marked read", `${marked.status} ${JSON.stringify(marked.body).slice(0, 160)}`);

    if (marked.body?.unreadNotices === count - 1) {
      ok(`and the reply carries the new count (${marked.body.unreadNotices}) — nothing to re-fetch`);
    } else {
      bad("the reply carries the new count", `expected ${count - 1}, got ${marked.body?.unreadNotices}`);
    }

    const reread = (await notices()).filter((n) => n.kind !== "message");
    const one = reread.find((n) => n._id === target._id);
    if (one?.read === true) ok("that card is read");
    else bad("the marked card reports itself read", JSON.stringify(one?.read));
    if (reread.filter((n) => n.read === false).length === count - 1) {
      ok("and the rest are untouched");
    } else {
      bad("only the marked notice changed", JSON.stringify(reread.map((n) => [n.kind, n.read])));
    }

    // Idempotent: the phone marks optimistically and retries nothing.
    const again = await mother("POST", `/api/portal/notifications/${target._id}/read`);
    if (again.status === 200 && again.body?.unreadNotices === count - 1) {
      ok("marking it twice is the same as marking it once");
    } else {
      bad("marking read is idempotent", `${again.status} unread=${again.body?.unreadNotices}`);
    }

    // One notice, two parents, two receipts.
    const fatherCount = (await father("GET", "/api/portal/me")).body?.data?.unreadNotices ?? null;
    const fatherRow = (await notices(father)).find((n) => n._id === target._id);
    if (fatherRow?.read === false) ok("the child's other guardian still has it unread");
    else bad("receipts are per guardian", JSON.stringify(fatherRow?.read));
    if (fatherCount === count) ok(`and their own count is untouched (${fatherCount})`);
    else bad("one guardian reading does not clear the other", `${fatherCount} vs ${count}`);

    // Scope. A guardian may not stamp a receipt onto another family's notice,
    // and may not learn from the answer whether one exists.
    await Notification.create({
      _id: "notif-elsewhere", schoolId: SCHOOL, studentId: "stu-other",
      kind: "gate.arrival", to: "—", channel: "log",
      subject: "Arrived at school", body: "Someone Else arrived at 07:50.",
      status: "skipped", skipReason: "No email address on file",
    });
    const foreign = await mother("POST", "/api/portal/notifications/notif-elsewhere/read");
    if (foreign.status === 404) ok("another child's notice cannot be marked");
    else bad("marking is scoped to the caller's children", String(foreign.status));

    const invented = await mother("POST", "/api/portal/notifications/does-not-exist/read");
    if (invented.status === 404) ok("and neither can one that does not exist — the same answer");
    else bad("an unknown id is a 404", String(invented.status));

    // The floor, so switching to per-notice receipts lights up no history.
    await Notification.updateMany({ schoolId: SCHOOL }, { $set: { readBy: [] } });
    await GuardianAccess.updateOne({ _id: MOTHER, schoolId: SCHOOL },
      { $set: { noticesSeenAt: new Date() } });
    const floored = await mother("GET", "/api/portal/me");
    if ((floored.body?.data?.unreadNotices ?? null) === 0) {
      ok("a term of history behind the old marker counts as read");
    } else {
      bad("noticesSeenAt is the floor", String(floored.body?.data?.unreadNotices));
    }
    const flooredRows = (await notices()).filter((n) => n.kind !== "message");
    if (flooredRows.every((n) => n.read === true)) {
      ok("and those cards show read, so the list agrees with the badge");
    } else {
      bad("the cards agree with the floor", JSON.stringify(flooredRows.map((n) => n.read)));
    }

    // Something arriving after the floor is new again.
    await GuardianAccess.updateOne({ _id: MOTHER, schoolId: SCHOOL },
      { $set: { noticesSeenAt: new Date(Date.now() - 1000) } });
    await scan(localTime(16, 40, 10));
    const later = await mother("GET", "/api/portal/me");
    if ((later.body?.data?.unreadNotices ?? 0) >= 1) {
      ok("and a notice arriving afterwards is unread again");
    } else {
      bad("a new notice raises the count", String(later.body?.data?.unreadNotices));
    }

    // The unread-thread rows are NOT in this count — the Messages badge owns
    // those, and one number in two badges is a number nobody trusts.
    await staff("POST", `/api/messages/conversations/${convId}/messages`, {
      schoolId: SCHOOL, body: "One more thing.",
    });
    const r = await mother("GET", "/api/portal/notifications");
    const msgRows = (r.body?.data ?? []).filter((n) => n.kind === "message");
    const noticeRows = (r.body?.data ?? []).filter((n) => n.kind !== "message");
    if (msgRows.length === 1 &&
        r.body.unreadNotices === noticeRows.filter((n) => n.read === false).length) {
      ok("an unread thread is counted by Messages, not twice");
    } else {
      bad("the two badges do not double-count",
        `message rows ${msgRows.length}, unreadNotices ${r.body?.unreadNotices},` +
        ` unread cards ${noticeRows.filter((n) => n.read === false).length}`);
    }
  }
  // ═════════════════════════════════════════════════════════════════════════
  // One way in, so this cannot be got wrong a fourth time
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Every one of the defects above was a producer or a consumer making its own
  // decision about what a notification is: the gate deciding that "do not
  // email this" meant "do not record it", the portal deciding that a delivery
  // status was a visibility rule, the messaging module deciding to assemble
  // its own notices on the phone. None of them were unreasonable alone.
  //
  // So the shape is asserted, not just the behaviour. enqueue() is the only
  // way a Notification comes into existence, and it is the only place the
  // record/delivery distinction lives.
  console.log("\n--- and there is one way to create a notification ---");
  {
    const fs   = require("fs");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
      return e.name.endsWith(".js") ? [full] : [];
    });

    // The rule is about CREATION, and this said `updateMany` too.
    //
    // It was written as a blunt catch-all and it caught the wrong thing the
    // moment a reader appeared: /notifications/read-all stamps a receipt with
    // updateMany, which creates nothing. Worse, it never listed updateOne, so
    // the single-notice version of the same write slipped past — the pattern
    // was arbitrary rather than expressing the rule.
    //
    // What must stay true: no producer outside the service brings a
    // notification into existence, because each one would then answer the
    // record-versus-delivery question for itself and one of them would get it
    // wrong. Creation is `create`, `insertMany`, and an update with `upsert`.
    // Stamping who has read one is not creation.
    const CREATES = [
      /Notification\.(?:create|insertMany)\s*\(/,
      /Notification\.update\w*\([\s\S]{0,600}?upsert:\s*true/,
      /Notification\.findOneAndUpdate\([\s\S]{0,600}?upsert:\s*true/,
    ];

    const offenders = walk(SRC)
      .filter((f) => !f.includes(path.join("services", "notification")))
      .filter((f) => {
        const text = fs.readFileSync(f, "utf8");
        return CREATES.some((re) => re.test(text));
      });

    if (!offenders.length) {
      ok("nothing outside the notification service creates a notification");
    } else {
      bad("notifications are only created through enqueue()",
        offenders.map((f) => "  " + path.relative(ROOT, f)).join("\n") + "\n" +
        "A producer that writes the row itself gets its own answer to the\n" +
        "record-versus-delivery question, and one of them will get it wrong.");
    }

    // And the narrowing must not have made the check vacuous: the service
    // itself still has to be the one place that creates them.
    const svcText = fs.readFileSync(path.join(SRC, "services/notification/index.js"), "utf8");
    if (/Notification\.create\s*\(/.test(svcText)) {
      ok("and the service is where that happens");
    } else {
      bad("the notification service creates the rows",
        "If nothing creates them here either, this check proves nothing.");
    }

    const svc = fs.readFileSync(path.join(SRC, "services/notification/index.js"), "utf8");
    if (/deliver\s*=\s*true/.test(svc) && /deliverReason/.test(svc)) {
      ok("and enqueue is where the record/delivery split is expressed");
    } else {
      bad("enqueue carries the deliver flag",
        "The split has to live in one place or every producer re-invents it.");
    }

    // A producer that says nothing still gets a delivered notification — the
    // default must not have quietly become "record but do not send".
    const before = await Notification.countDocuments({ schoolId: SCHOOL, kind: "fee.reminder" });
    const notify = require(path.join(SRC, "services/notification"));
    const plain  = await notify.enqueue({
      schoolId: SCHOOL, kind: "fee.reminder", studentId: STUDENT,
      data: { amount: 5000, currency: "XAF" },
    });
    if (plain && plain.skipReason && /address/i.test(plain.skipReason)) {
      ok("a producer that says nothing still asks for delivery (and here has no address)");
    } else {
      bad("deliver defaults to true",
        JSON.stringify({ status: plain?.status, skipReason: plain?.skipReason, before }));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Kinds the portal will show that nothing ever creates
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Not a defect fixed here, but the audit turned it up and an assertion is the
  // only way it stays known.
  //
  // The portal's allowlist admits seven kinds, and the codebase now produces
  // four of them: fee.reminder, gate.arrival, gate.departure and
  // attendance.absent. The other three are complete in every respect except
  // that nothing creates them — the enum admits them, the templates render
  // them in both languages, the allowlist would show them, and no code path
  // enqueues one.
  //
  // What that costs a parent varies, and the difference matters:
  //
  //   fee.payment         the fees tab shows the payment and the receipt, so
  //                       the fact is reachable; the notice is not.
  //   result.published    the results tab shows the card once published.
  //   announcement        the news tab reads the Announcement collection.
  //
  // So all three that remain are a notice missing over information a parent can
  // still find in another tab. The one that was a silent gap — a child marked
  // absent and nobody told, on any surface — has a producer now.
  console.log("\n--- and the kinds nothing produces are known ---");
  {
    const fs   = require("fs");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
      return e.name.endsWith(".js") ? [full] : [];
    });

    // Every kind that reaches enqueue, read off the call sites rather than
    // guessed. A fixed window after `enqueue({` and the first `kind:` line in
    // it — matching to the closing brace instead looked tidier and got this
    // wrong, because these calls carry a nested `data: { … }` and the first
    // `})` is not the end of the argument.
    const producers = new Set();
    for (const f of walk(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/enqueue\(\{/g)) {
        const window   = text.slice(m.index, m.index + 300);
        const kindLine = /\bkind:([^\n]*)/.exec(window);
        if (!kindLine) continue;
        // The gate's is a ternary and names both directions on one line.
        for (const lit of kindLine[1].matchAll(/"([a-z]+\.[a-z]+)"/g)) producers.add(lit[1]);
      }
    }

    const allowed = [
      "fee.reminder", "fee.payment", "attendance.absent",
      "gate.arrival", "gate.departure", "result.published", "announcement",
    ];
    const dead     = allowed.filter((k) => !producers.has(k)).sort();
    // attendance.absent left this list when its producer was written — which
    // is what this assertion is for. It was the only one of the four where the
    // fact was unreachable by any other route.
    const EXPECTED = ["announcement", "fee.payment", "result.published"];

    if (String(dead) === String(EXPECTED)) {
      ok(`${dead.length} allowlisted kinds have no producer (${dead.join(", ")}) — known gap`);
    } else {
      bad("the set of producerless kinds is what it was",
        `now:      ${dead.join(", ") || "none"}\n` +
        `expected: ${EXPECTED.join(", ")}\n` +
        `A kind gaining a producer is good news and belongs in this list.\n` +
        `A kind losing one is a parent quietly stopping being told something.`);
    }

    if (producers.has("gate.arrival") && producers.has("gate.departure") &&
        producers.has("fee.reminder") && producers.has("attendance.absent")) {
      ok("and the four that do are the gate's two, the fee reminder and absences");
    } else {
      bad("the produced kinds are the expected four", [...producers].join(", "));
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
