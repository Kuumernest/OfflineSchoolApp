// backend/scripts/check-announcement-tenancy.js
"use strict";

/**
 * Assert that one school cannot reach another school's announcements.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * It did not, and the guard was missing.
 *
 * Announcement ids in this system are sometimes ObjectIds and sometimes strings,
 * and findById() raises a CastError on a non-hex string. The repair was a model
 * helper, findByAnyId(), which tries both — and the "✅ FIX" comments through
 * announcement.routes.js are that repair being applied at eight call sites.
 *
 * What those call sites previously did was findOne({ _id, schoolId }). The
 * schoolId went with them. Every route then decided authorisation from
 * `isAuthor || isAdmin`, and isAdmin is a ROLE check:
 *
 *     const isAdmin = ["super_admin", "school_admin"].includes(req.user.role);
 *
 * So a school_admin of one school could edit or delete an announcement belonging
 * to another, and any authenticated user could mark one read or acknowledged,
 * given only its id. Nothing in the path compared the announcement's school with
 * the caller's — the word schoolId did not appear in any of the five write
 * handlers, though the model carries the field and three compound indexes lead
 * with it.
 *
 * That is the shape of regression worth a test of its own: a fix for one bug
 * quietly removed a guard nobody was looking at, and the tests that existed all
 * used one school.
 *
 * So every assertion below is cross-school. A single-school test cannot fail on
 * this no matter how carefully it is written.
 *
 *   node scripts/check-announcement-tenancy.js
 */

const express  = require("express");
const mongoose = require("mongoose");

const SCHOOL_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SCHOOL_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "announcement-tenancy" });

  const Announcement = require("../src/db/models/Announcement");
  const { ROLES }    = require("../src/config/roles");

  // Registered because the read route populates targetClasses and the author.
  // Without them mongoose throws "Schema hasn't been registered for model" and
  // the endpoint answers 500 — which would have made the control assertions here
  // fail for a reason that has nothing to do with tenancy.
  require("../src/db/models/Class");
  require("../src/db/models/User");

  /**
   * Whoever is asking. Mutated between blocks rather than starting a second
   * server, so the school and role in play are visible beside the assertions.
   */
  let actor = {
    _id: "admin-a", id: "admin-a", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL_A, email: "head@a.com",
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use("/api/announcements", require("../src/routes/announcement.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* not every response is json */ }
    return { status: res.status, body: payload };
  };

  /** A fresh pair of announcements, one per school. Ids are strings on purpose. */
  const seed = async () => {
    await Announcement.deleteMany({});
    await Announcement.collection.insertMany([
      {
        _id: "ann-a", schoolId: SCHOOL_A, title: "School A notice",
        body: "For our own parents", audience: "all", author: "admin-a",
        isActive: true, isPinned: false, deletedAt: null, version: 1,
        readBy: [], acknowledgedBy: [], createdAt: new Date(), updatedAt: new Date(),
      },
      {
        _id: "ann-b", schoolId: SCHOOL_B, title: "School B notice",
        body: "None of A's business", audience: "all", author: "admin-b",
        isActive: true, isPinned: false, deletedAt: null, version: 1,
        readBy: [], acknowledgedBy: [], createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
  };

  await seed();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a school admin cannot reach another school's announcement ---");

  // The control: their own works. Without this the assertions below could all
  // pass because the endpoint is broken for everybody.
  const own = await call("PUT", "/api/announcements/ann-a", {
    title: "School A notice, edited",
  });
  check("editing their own succeeds", own.status, 200);
  check("and it really changed",
    (await Announcement.findById("ann-a").lean())?.title, "School A notice, edited");

  // THE ASSERTION THIS FILE EXISTS FOR.
  const other = await call("PUT", "/api/announcements/ann-b", {
    title: "Edited from another school",
  });
  check("editing another school's is refused", other.status, 404);
  check("and it is untouched",
    (await Announcement.findById("ann-b").lean())?.title, "School B notice");

  const deleted = await call("DELETE", "/api/announcements/ann-b");
  check("deleting another school's is refused", deleted.status, 404);
  check("and it is still there",
    (await Announcement.findById("ann-b").lean())?.deletedAt, null);

  // 404 rather than 403, deliberately: somebody outside a school should not
  // learn that one of its announcements exists.
  check("the refusal does not admit the row exists", other.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- nor mark it read, acknowledged or pinned ---");

  const read = await call("POST", "/api/announcements/students/ann-b/read", {});
  check("marking another school's read is refused", read.status, 404);

  const ack = await call("POST", "/api/announcements/students/ann-b/acknowledge", {});
  check("acknowledging it is refused", ack.status, 404);

  check("and neither left a receipt on the row", {
    readBy:         (await Announcement.findById("ann-b").lean())?.readBy?.length ?? 0,
    acknowledgedBy: (await Announcement.findById("ann-b").lean())?.acknowledgedBy?.length ?? 0,
  }, { readBy: 0, acknowledgedBy: 0 });

  const seen = await call("GET", "/api/announcements/ann-b");
  check("and it cannot even be read", seen.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a teacher is confined the same way ---");

  actor = {
    _id: "teacher-a", id: "teacher-a", role: ROLES.TEACHER,
    schoolId: SCHOOL_A, email: "t@a.com",
  };

  const asTeacher = await call("GET", "/api/announcements/ann-b");
  check("a teacher cannot read another school's", asTeacher.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a super_admin still crosses schools, which is the point of it ---");

  actor = {
    _id: "root", id: "root", role: ROLES.SUPER_ADMIN,
    schoolId: null, email: "root@x.com",
  };

  const asRoot = await call("GET", "/api/announcements/ann-b");
  check("a super_admin may read any school's", asRoot.status, 200);

  const rootEdit = await call("PUT", "/api/announcements/ann-b", {
    title: "Corrected centrally",
  });
  check("and may edit it", rootEdit.status, 200);
  check("which really applied",
    (await Announcement.findById("ann-b").lean())?.title, "Corrected centrally");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and the id duality the helper was written for still works ---");

  // findByAnyId exists because an id may be a 24-character hex string stored as
  // a STRING rather than an ObjectId. The tenancy filter must not have broken
  // that: a fix that reintroduced the CastError would be a different outage.
  actor = {
    _id: "admin-a", id: "admin-a", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL_A, email: "head@a.com",
  };

  await Announcement.collection.insertOne({
    _id: "0123456789abcdef01234567", schoolId: SCHOOL_A, title: "Hex-shaped string id",
    body: "b", audience: "all", author: "admin-a", isActive: true, isPinned: false,
    deletedAt: null, version: 1, readBy: [], acknowledgedBy: [],
    createdAt: new Date(), updatedAt: new Date(),
  });

  const hexish = await call("GET", "/api/announcements/0123456789abcdef01234567");
  check("a hex-shaped string id is still found", hexish.status, 200);

  const nonHex = await call("GET", "/api/announcements/not-a-hex-id-at-all");
  check("and a plainly missing one is a 404, not a 500", nonHex.status, 404);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
