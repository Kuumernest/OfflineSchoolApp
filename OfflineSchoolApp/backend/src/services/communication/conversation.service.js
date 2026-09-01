// backend/src/services/communication/conversation.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONVERSATION SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything that touches the database on behalf of messaging. The policy
 * lives next door in policy.service.js and is pure; this module is where
 * that policy meets real rows.
 *
 * The one rule worth stating plainly: no function here decides who may talk
 * to whom. They take an already-authorised principal and act. Routes ask
 * the policy first. Keeping the decision in one pure module is what makes
 * it testable and what stops a new endpoint quietly inventing its own rules.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { v4: uuidv4 } = require("uuid");

const Conversation   = require("../../db/models/Conversation");
const Message        = require("../../db/models/Message");
const Counter        = require("../../db/models/Counter");
const User           = require("../../db/models/User");
const School         = require("../../db/models/School");
const GuardianAccess = require("../../db/models/GuardianAccess");
const Student           = require("../../db/models/Student");
const Class             = require("../../db/models/Class");
const TeacherAssignment = require("../../db/models/TeacherAssignment");

const policy = require("./policy.service");

// ── Principals ──────────────────────────────────────────────────────────────

/**
 * Who is making this request?
 *
 * Staff and students arrive as req.user (a User). Guardians arrive as
 * req.portal, set by the portal router's own token guard — they are not
 * Users and have no role. Returns null when neither is present.
 */
function principalFromRequest(req) {
  if (req.portal?.schoolId) {
    // accessId is the GuardianAccess row — the guardian's identity. It is
    // deliberately NOT studentId: one guardian may hold several children,
    // and keying conversations on a child would give the same person a
    // different identity per child.
    return {
      kind:       "guardian",
      id:         String(req.portal.accessId),
      schoolId:   String(req.portal.schoolId),
      studentIds: (req.portal.studentIds ?? []).filter(Boolean).map(String),
      name:       "Parent/Guardian",
    };
  }

  if (req.user?._id) {
    return {
      kind:     "user",
      id:       String(req.user._id),
      role:     req.user.role,
      schoolId: req.user.schoolId ? String(req.user.schoolId) : null,
      name:     req.user.name || req.user.fullName || null,
    };
  }

  return null;
}

/**
 * Build the principal for somebody being addressed.
 *
 * Returns null when the target does not exist or sits in another school —
 * the caller should treat that as "not found" rather than leaking whether
 * the id exists elsewhere.
 */
async function resolveTargetPrincipal(schoolId, kind, id) {
  if (!schoolId || !id) return null;

  if (kind === "guardian") {
    const g = await GuardianAccess.findOne({
      _id:       String(id),
      schoolId:  String(schoolId),
      revokedAt: null,
    }).select("_id schoolId studentIds label").lean();

    if (!g) return null;
    return {
      kind:       "guardian",
      id:         String(g._id),
      schoolId:   String(g.schoolId),
      studentIds: (g.studentIds || []).map(String),
      name:       g.label || "Parent/Guardian",
    };
  }

  const u = await User.findOne({ _id: String(id), schoolId: String(schoolId) })
    .select("_id role schoolId name isActive")
    .lean();

  if (!u || u.isActive === false) return null;

  return {
    kind:     "user",
    id:       String(u._id),
    role:     u.role,
    schoolId: String(u.schoolId),
    name:     u.name || null,
  };
}

/**
 * People this principal might be able to message, as principals.
 *
 * This NARROWS; it does not decide. The caller runs every result through
 * policy.canMessage(), which is the actual gate. The narrowing exists only so
 * a school with four thousand students does not load four thousand rows to
 * throw most of them away.
 *
 * Guardians are included for staff because "the parent of a child in my
 * class" is the single most useful conversation in the module, and they are
 * excluded for students because the matrix forbids that direction anyway.
 */
async function findCandidateRecipients(principal, settings, { q = "", limit = 40 } = {}) {
  const schoolId = String(principal.schoolId);
  const kind     = policy.principalKind(principal);

  // Anchored regex, escaped: a name is user input, and an unescaped one would
  // let somebody paste a pattern that scans the whole collection.
  const safe   = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = safe ? new RegExp(safe, "i") : null;

  // Which User roles are worth loading at all.
  let roles;
  if (kind === "admin")         roles = ["super_admin", "school_admin", "admin", "teacher", "student"];
  else if (kind === "teacher")  roles = ["super_admin", "school_admin", "admin", "teacher", "student"];
  else if (kind === "student")  roles = settings.studentToStudent
    ? ["super_admin", "school_admin", "admin", "teacher", "student"]
    : ["super_admin", "school_admin", "admin", "teacher"];
  else if (kind === "guardian") roles = ["super_admin", "school_admin", "admin", "teacher"];
  else return [];

  const userFilter = { schoolId, role: { $in: roles }, isActive: { $ne: false } };
  if (nameRe) userFilter.name = nameRe;

  const users = await User.find(userFilter)
    .select("_id name role")
    .limit(limit)
    .lean();

  const out = users.map((u) => ({
    kind:     "user",
    id:       String(u._id),
    role:     u.role,
    schoolId,
    name:     u.name || "Unnamed",
    subtitle: u.role,
  }));

  // A guardian's own children, so a parent can reach their child directly.
  if (kind === "guardian" && (principal.studentIds || []).length) {
    const kids = await User.find({
      schoolId,
      role: "student",
      _id:  { $in: principal.studentIds.map(String) },
    }).select("_id name role").limit(limit).lean();

    for (const k of kids) {
      out.push({
        kind: "user", id: String(k._id), role: "student", schoolId,
        name: k.name || "Unnamed", subtitle: "your child",
      });
    }
  }

  // Guardians as recipients, for staff.
  if (kind === "admin" || kind === "teacher") {
    const gFilter = { schoolId, revokedAt: null };
    if (nameRe) gFilter.label = nameRe;

    const guardians = await GuardianAccess.find(gFilter)
      .select("_id label studentIds")
      .limit(limit)
      .lean();

    for (const g of guardians) {
      out.push({
        kind:       "guardian",
        id:         String(g._id),
        schoolId,
        studentIds: (g.studentIds || []).map(String),
        name:       g.label || "Parent/Guardian",
        subtitle:   `guardian of ${(g.studentIds || []).length} student(s)`,
      });
    }
  }

  // Never offer somebody themselves.
  const meKey = policy.participantKey(principal);
  return out.filter((c) => policy.participantKey(c) !== meKey);
}

/** The school's communication settings, defaults already applied. */
async function loadSettings(schoolId) {
  if (!schoolId) return policy.resolveSettings(null);
  const school = await School.findById(String(schoolId))
    .select("communication")
    .lean();
  return policy.resolveSettings(school?.communication);
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * The next sequence number for a conversation.
 *
 * findOneAndUpdate with $inc is atomic, so two devices posting at the same
 * instant get different numbers. This is the whole ordering guarantee: every
 * reader sorts by seq, so everyone sees the same conversation in the same
 * order regardless of how wrong the senders' clocks were.
 */
async function nextSeq(conversationId) {
  const row = await Counter.findByIdAndUpdate(
    `conversation:${conversationId}`,
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean();
  return row.seq;
}

// ── Participants ────────────────────────────────────────────────────────────

/** A participant subdocument from a principal. */
const toParticipant = (p) => ({
  kind:             p.kind === "guardian" ? "guardian" : "user",
  id:               String(p.id),
  name:             p.name || null,
  role:             p.kind === "guardian" ? "guardian" : (p.role || null),
  joinedAt:         new Date(),
  lastReadSeq:      0,
  lastDeliveredSeq: 0,
});

// ── Conversations ───────────────────────────────────────────────────────────

/**
 * Find, or create, the direct thread between two principals.
 *
 * Races on the unique directKey index rather than checking first and then
 * writing: two devices opening the same chat simultaneously is ordinary on
 * a flaky link, and a check-then-insert would give them a thread each.
 */
async function openDirect(from, to) {
  const schoolId  = String(from.schoolId);
  const directKey = Conversation.buildDirectKey(from, to);

  const existing = await Conversation.findOne({
    schoolId, directKey, deletedAt: null,
  });
  if (existing) return existing;

  try {
    return await Conversation.create({
      _id:       uuidv4(),
      schoolId,
      kind:      "direct",
      directKey,
      participants: [toParticipant(from), toParticipant(to)],
      createdBy: String(from.id),
    });
  } catch (err) {
    // The other device won the race. Its thread is the right one.
    if (err?.code === 11000) {
      return Conversation.findOne({ schoolId, directKey, deletedAt: null });
    }
    throw err;
  }
}

// ── Class groups ────────────────────────────────────────────────────────────

/**
 * Everyone who belongs in a class's group conversation.
 *
 * Two sources for the student roster, because this codebase links students to
 * classes in both styles: some rows carry User.classId directly, others only
 * exist as a Student row pointing at a userId. Reading only one would leave
 * half a class out of its own group.
 *
 * A Student row with no userId is skipped — a pending application has no login
 * identity, so there is nobody to add.
 *
 * Teachers assigned to the class are included. A class group with no teacher
 * in it is a room full of pupils and no adult, which is not what a school
 * means by a class channel.
 */
async function classGroupMembers(schoolId, classId) {
  const [direct, roster, assignments] = await Promise.all([
    User.find({
      schoolId, classId, role: "student", isActive: { $ne: false },
    }).select("_id name role").lean(),

    Student.find({
      schoolId, classId, deletedAt: null, userId: { $ne: null },
    }).select("userId").lean(),

    TeacherAssignment.find({
      schoolId, class: classId, isActive: true,
    }).select("teacher").lean(),
  ]);

  const byId = new Map();

  for (const u of direct) {
    byId.set(String(u._id), {
      kind: "user", id: String(u._id), schoolId,
      name: u.name || null, role: "student",
    });
  }

  // Pull in students the roster knows about but User.classId does not.
  const rosterIds = roster
    .map((r) => String(r.userId))
    .filter((id) => !byId.has(id));

  if (rosterIds.length) {
    const extra = await User.find({
      _id: { $in: rosterIds }, schoolId, isActive: { $ne: false },
    }).select("_id name role").lean();

    for (const u of extra) {
      byId.set(String(u._id), {
        kind: "user", id: String(u._id), schoolId,
        name: u.name || null, role: u.role || "student",
      });
    }
  }

  const teacherIds = [...new Set(assignments.map((a) => String(a.teacher)))]
    .filter((id) => !byId.has(id));

  if (teacherIds.length) {
    const teachers = await User.find({
      _id: { $in: teacherIds }, schoolId, isActive: { $ne: false },
    }).select("_id name role").lean();

    for (const u of teachers) {
      byId.set(String(u._id), {
        kind: "user", id: String(u._id), schoolId,
        name: u.name || null, role: u.role || "teacher",
      });
    }
  }

  return [...byId.values()];
}

/**
 * The group conversation for a class, created if it does not exist and its
 * membership brought in line with the current roster.
 *
 * Classes are not created by hand in messaging — a class IS a group, so the
 * conversation is provisioned on demand and reconciled every time it is
 * touched. That keeps it correct as students are enrolled, promoted or moved
 * between classes without anybody having to remember to update a member list.
 *
 * Existing participants keep their read markers: reconciling replaces the
 * roster, not the state of the people already in it, or every enrolment would
 * mark the whole class unread.
 */
async function ensureClassConversation(schoolId, classId) {
  if (!schoolId || !classId) return null;

  const cls = await Class.findOne({
    _id: String(classId), schoolId: String(schoolId), deletedAt: null,
  }).select("_id name section").lean();

  if (!cls) return null;

  const title = [cls.name, cls.section].filter(Boolean).join(" ") || "Class";
  const members = await classGroupMembers(String(schoolId), String(classId));

  let convo = await Conversation.findOne({
    schoolId: String(schoolId), kind: "class", classId: String(classId),
    deletedAt: null,
  });

  if (!convo) {
    try {
      convo = await Conversation.create({
        _id:          uuidv4(),
        schoolId:     String(schoolId),
        kind:         "class",
        classId:      String(classId),
        title,
        participants: members.map(toParticipant),
        createdBy:    null,
      });
      return convo;
    } catch (err) {
      // Another request provisioned it first; use theirs.
      if (err?.code !== 11000) throw err;
      convo = await Conversation.findOne({
        schoolId: String(schoolId), kind: "class", classId: String(classId),
        deletedAt: null,
      });
      if (!convo) throw err;
    }
  }

  // Reconcile: add anyone missing, drop anyone no longer in the class, and
  // leave the read state of everyone who stays untouched.
  const wanted  = new Map(members.map((m) => [policy.participantKey(m), m]));
  const current = new Map(
    convo.participants.map((p) => [policy.participantKey(p), p])
  );

  const kept = convo.participants.filter((p) =>
    wanted.has(policy.participantKey(p))
  );
  const added = members
    .filter((m) => !current.has(policy.participantKey(m)))
    .map(toParticipant);

  if (added.length || kept.length !== convo.participants.length ||
      convo.title !== title) {
    convo.participants = [...kept, ...added];
    convo.title        = title;
    await convo.save();
  }

  return convo;
}

/**
 * Provision and reconcile every class group this principal belongs in.
 *
 * Called when somebody lists their conversations, which is the moment their
 * view has to be right. A student has one class; a teacher has the classes
 * they are assigned to; an admin is not auto-enrolled into every class in the
 * school, because being able to audit a channel is not the same as being in it.
 */
async function ensureClassConversationsFor(principal) {
  if (!principal || principal.kind !== "user" || !principal.schoolId) return [];

  const schoolId = String(principal.schoolId);
  const kind     = policy.principalKind(principal);
  const classIds = new Set();

  if (kind === "student") {
    const [u, s] = await Promise.all([
      User.findById(String(principal.id)).select("classId").lean(),
      Student.findOne({
        schoolId, userId: String(principal.id), deletedAt: null,
      }).select("classId").lean(),
    ]);
    if (u?.classId) classIds.add(String(u.classId));
    if (s?.classId) classIds.add(String(s.classId));
  } else if (kind === "teacher") {
    const rows = await TeacherAssignment.find({
      schoolId, teacher: String(principal.id), isActive: true,
    }).select("class").lean();
    for (const r of rows) if (r.class) classIds.add(String(r.class));
  }

  const out = [];
  for (const cid of classIds) {
    const c = await ensureClassConversation(schoolId, cid).catch((err) => {
      console.warn(`[comms] class group for ${cid} failed:`, err.message);
      return null;
    });
    if (c) out.push(c);
  }
  return out;
}

/**
 * Create a group, class or subject channel.
 * Membership is decided by the caller; this only writes it down.
 */
async function createChannel({
  schoolId, kind, title, description, participants, classId, subjectId, createdBy,
}) {
  return Conversation.create({
    _id:          uuidv4(),
    schoolId:     String(schoolId),
    kind,
    title:        title || null,
    description:  description || null,
    participants: participants.map(toParticipant),
    classId:      classId   || null,
    subjectId:    subjectId || null,
    createdBy:    createdBy ? String(createdBy) : null,
  });
}

/** Conversations this principal belongs to, most recent first. */
async function listFor(principal, { limit = 50, before = null } = {}) {
  // $elemMatch, not two dotted conditions: the latter matches a conversation
  // where SOME participant has this kind and SOME OTHER has this id. A
  // guardian and a user can hold the same id string, so that form could list a
  // thread the caller is not in.
  const filter = {
    schoolId:     String(principal.schoolId),
    deletedAt:    null,
    participants: {
      $elemMatch: {
        kind: principal.kind === "guardian" ? "guardian" : "user",
        id:   String(principal.id),
      },
    },
  };
  if (before) filter.lastMessageAt = { $lt: new Date(before) };

  return Conversation.find(filter)
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .lean();
}

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * Post a message.
 *
 * `clientId` lets the sender choose the primary key so that a retry from the
 * mobile outbox collides instead of double-posting. A duplicate is answered
 * with the message already stored, which is what the sender wanted anyway.
 *
 * The caller must have checked policy.canPostToConversation first.
 */
async function postMessage({
  conversation, principal, body, attachments = [], replyTo = null,
  clientId = null, deviceCreatedAt = null, systemEvent = null,
}) {
  const text = String(body ?? "").trim();
  if (!text && attachments.length === 0 && !systemEvent) {
    const err = new Error("A message needs text or an attachment");
    err.status = 400;
    throw err;
  }

  // A reply must point at a message in the same thread; otherwise a client
  // could quote somebody else's private conversation into this one.
  if (replyTo) {
    const parent = await Message.findOne({
      _id:            String(replyTo),
      conversationId: conversation._id,
    }).select("_id").lean();
    if (!parent) {
      const err = new Error("The message being replied to is not in this conversation");
      err.status = 400;
      throw err;
    }
  }

  const seq = await nextSeq(conversation._id);

  let message;
  try {
    message = await Message.create({
      _id:            clientId ? String(clientId) : uuidv4(),
      conversationId: conversation._id,
      schoolId:       conversation.schoolId,
      seq,
      sender: {
        kind: principal.kind === "guardian" ? "guardian" : "user",
        id:   String(principal.id),
        name: principal.name || null,
        role: principal.kind === "guardian" ? "guardian" : (principal.role || null),
      },
      body:            text,
      attachments,
      replyTo:         replyTo || null,
      systemEvent,
      deviceCreatedAt: deviceCreatedAt ? new Date(deviceCreatedAt) : null,
    });
  } catch (err) {
    if (err?.code === 11000 && clientId) {
      // A retry of something already accepted. Hand back what is stored.
      const existing = await Message.findById(String(clientId));
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
  }

  // Denormalised tail, so the conversation list needs no second query. The
  // guard keeps a late-arriving offline message from dragging the preview
  // backwards past a newer one.
  await Conversation.updateOne(
    { _id: conversation._id, lastMessageSeq: { $lt: seq } },
    {
      $set: {
        lastMessageAt:      message.createdAt,
        lastMessageSeq:     seq,
        lastMessagePreview: text.slice(0, 140) || (attachments.length ? "[attachment]" : ""),
        lastMessageSender:  String(principal.id),
      },
    }
  );

  // Senders have read what they just sent.
  await markRead(conversation._id, principal, seq);

  return { message, duplicate: false };
}

/** Messages in a thread, newest first, paginated by seq. */
async function listMessages(conversationId, { limit = 50, beforeSeq = null } = {}) {
  const filter = { conversationId: String(conversationId) };
  if (beforeSeq != null) filter.seq = { $lt: Number(beforeSeq) };

  return Message.find(filter)
    .sort({ seq: -1 })
    .limit(Math.min(Number(limit) || 50, 100));
}

/**
 * Move a participant's read marker forward.
 *
 * $max, never $set: read receipts arrive out of order from devices that have
 * been offline, and a stale one must not un-read messages the person has
 * already seen.
 */
async function markRead(conversationId, principal, seq) {
  const kind = principal.kind === "guardian" ? "guardian" : "user";
  return Conversation.updateOne(
    {
      _id: String(conversationId),
      // $elemMatch, NOT two dotted conditions.
      //
      // { "participants.kind": k, "participants.id": i } is satisfied when
      // SOME element has that kind and SOME element has that id — not
      // necessarily the same one. The positional $ then binds to whichever
      // element matched first, so a read receipt landed on another
      // participant and moved a stranger's marker instead of the sender's.
      // $elemMatch forces both conditions onto one element, which is what $
      // then refers to.
      participants: { $elemMatch: { kind, id: String(principal.id) } },
    },
    { $max: { "participants.$.lastReadSeq": Number(seq) || 0 } }
  );
}

/** As markRead, and for the same $elemMatch reason. */
async function markDelivered(conversationId, principal, seq) {
  const kind = principal.kind === "guardian" ? "guardian" : "user";
  return Conversation.updateOne(
    {
      _id:          String(conversationId),
      participants: { $elemMatch: { kind, id: String(principal.id) } },
    },
    { $max: { "participants.$.lastDeliveredSeq": Number(seq) || 0 } }
  );
}

module.exports = {
  principalFromRequest,
  findCandidateRecipients,
  resolveTargetPrincipal,
  loadSettings,
  nextSeq,
  toParticipant,
  openDirect,
  createChannel,
  classGroupMembers,
  ensureClassConversation,
  ensureClassConversationsFor,
  listFor,
  postMessage,
  listMessages,
  markRead,
  markDelivered,
};
