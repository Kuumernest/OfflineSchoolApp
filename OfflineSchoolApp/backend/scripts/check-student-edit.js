// backend/scripts/check-student-edit.js
"use strict";

/**
 * A pupil's record could not be corrected, and the pupil could rewrite it.
 *
 * The office could approve, reject, suspend, restore, move and delete a
 * student. It could not change one field. A surname mistyped at admission was
 * permanent from the school's side — and that name prints on report cards,
 * identity cards, receipts and transcripts.
 *
 * Delete-and-re-create is not the way out: twenty collections carry a
 * studentId, so a fresh record detaches the pupil's marks, register, fees and
 * every report card already issued.
 *
 * Meanwhile PUT /api/student/profile let the pupil change their own firstName,
 * lastName, gender and dateOfBirth, with no approval and no record. The school
 * types the data at admission and answers for it; those four fields are what a
 * certificate asserts. So this suite pins both halves: the office can correct
 * the record, the pupil no longer rewrites their own identity, and every
 * correction leaves a trail with the previous value in it.
 *
 * ── The idempotency argument, asserted rather than assumed ────────────────
 *
 * StudentChangeLog has no de-duplication key. A row is written only where a
 * value actually moved, and that is what makes a replayed sync safe: the retry
 * finds each new value equal to the stored one, writes no history, and reports
 * nothing changed. A correction and then a correction back is genuine history
 * and must survive — any key clever enough to suppress the replay would
 * suppress that too.
 *
 *   node scripts/check-student-edit.js
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
  const User    = mongoose.model("User");
  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");
  const History = mongoose.model("StudentChangeLog");

  const A = "school-a";
  const B = "school-b";

  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId, isActive: true,
  });

  await mkUser("adm-a",  "school_admin", A, "Registrar A");
  await mkUser("bur-a",  "bursar",       A, "Bursar A");
  await mkUser("tea-a",  "teacher",      A, "Teacher A");
  await mkUser("stu-a",  "student",      A, "A Pupil");
  await mkUser("adm-b",  "school_admin", B, "Registrar B");

  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });
  await Class.create({ _id: "cls-b", schoolId: B, name: "Form 1 B" });

  const reset = async () => {
    await Student.deleteMany({});
    await History.deleteMany({});
    await Student.create({
      _id: "st-1", userId: "stu-a", schoolId: A, classId: "cls-a",
      firstName: "Bern", lastName: "Constanse",           // the misspelling
      name: "Bern Constanse", studentName: "Bern Constanse",
      dateOfBirth: "2011-04-02", gender: "female",
      guardianPhone: "670000000",
      enrollmentNo: "E-1", status: "approved", isActive: true,
    });
    await Student.create({
      _id: "st-b", userId: "usr-b", schoolId: B, classId: "cls-b",
      studentName: "Someone Else", name: "Someone Else",
      enrollmentNo: "B-1", status: "approved", isActive: true,
    });
  };
  await reset();

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  const studentRoutes = require(path.join(SRC, "routes/students.routes"));
  app.use("/api/students", auth.authenticate, studentRoutes);
  app.use("/api/student",  auth.authenticate, studentRoutes);
  const server = app.listen(0);
  const port   = server.address().port;

  const tok = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });

  const TOK = {
    adminA:  tok("adm-a", "school_admin", A),
    bursarA: tok("bur-a", "bursar",       A),
    teacherA:tok("tea-a", "teacher",      A),
    student: tok("stu-a", "student",      A),
    adminB:  tok("adm-b", "school_admin", B),
  };

  const call = async (who, method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: `Bearer ${TOK[who]}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };

  const edit = (who, patch, id = "st-1") =>
    call(who, "PATCH", `/api/students/${id}`, { schoolId: A, ...patch });

  // ── The route exists at all ─────────────────────────────────────────────────
  console.log("\n--- the office can correct a record ---");
  {
    const r = await edit("adminA", { lastName: "Constance" });
    if (r.status < 400) ok(`a school admin can edit a pupil (${r.status})`);
    else bad("a school admin can edit a pupil", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const after = await Student.findById("st-1").lean();
    if (after.lastName === "Constance") ok("the corrected surname is stored");
    else bad("the surname is stored", `lastName = ${JSON.stringify(after.lastName)}`);

    // studentName, not `name`: `name` is not a path on this schema and the
    // schema is strict, so writing it is a silent no-op. resolveDisplayName
    // reads firstName+lastName first and studentName second.
    if (after.studentName === "Bern Constance") {
      ok("and the denormalised studentName follows it");
    } else {
      bad("studentName follows the correction", JSON.stringify(after.studentName));
    }
    if (after.name === undefined) {
      ok("while `name` stays absent — it is not a field on this schema");
    } else {
      bad("`name` is not written", JSON.stringify(after.name));
    }

    if (Array.isArray(r.body?.changed) && r.body.changed.includes("lastName")) {
      ok("the response names the fields it changed");
    } else {
      bad("the response names what changed", JSON.stringify(r.body?.changed));
    }
  }

  // ── The history, which is the point ────────────────────────────────────────
  console.log("\n--- and the record's previous value survives ---");
  {
    const rows = await History.find({ studentId: "st-1" }).lean();
    if (rows.length === 1) ok("one history row for one changed field");
    else bad("one row per changed field", `${rows.length} row(s)`);

    const row = rows[0] || {};
    if (row.previousValue === "Constanse") ok("the overwritten value is recoverable");
    else bad("the overwritten value is recoverable", `previousValue = ${JSON.stringify(row.previousValue)}`);

    if (row.newValue === "Constance") ok("alongside what replaced it");
    else bad("the new value is recorded", JSON.stringify(row.newValue));

    if (row.field === "lastName") ok("named by schema path, not by a translated label");
    else bad("the field is a schema path", JSON.stringify(row.field));

    if (row.changedBy === "adm-a" && row.changedByName === "Registrar A" &&
        row.changedByRole === "school_admin") {
      ok("with who made the correction, and in what role");
    } else {
      bad("the actor is recorded",
        `${row.changedBy} / ${row.changedByName} / ${row.changedByRole}`);
    }

    if (row.changedAt instanceof Date) ok("and when");
    else bad("the change is timestamped", String(row.changedAt));

    if (row.studentName === "Bern Constanse") {
      ok("the pupil's name AS IT STOOD is kept, so the row still reads later");
    } else {
      bad("the name at the time is denormalised", JSON.stringify(row.studentName));
    }
  }

  // ── A multi-field save is one edit ─────────────────────────────────────────
  console.log("\n--- three corrections in one save are one edit ---");
  {
    await reset();
    await edit("adminA", {
      lastName: "Constance", guardianPhone: "690123456", dateOfBirth: "2011-04-03",
    });
    const rows = await History.find({ studentId: "st-1" }).lean();
    if (rows.length === 3) ok("three changed fields are three rows");
    else bad("three rows", `${rows.length}`);

    const batches = new Set(rows.map((r) => r.batchId));
    if (batches.size === 1 && [...batches][0]) ok("sharing one batchId, so it reads as a single edit");
    else bad("one batchId", JSON.stringify([...batches]));
  }

  // ── Unchanged fields write nothing: the replay argument ───────────────────
  console.log("\n--- and a replay writes no history ---");
  {
    await reset();
    const first = await edit("adminA", { lastName: "Constance" });
    const again = await edit("adminA", { lastName: "Constance" });

    const rows = await History.find({ studentId: "st-1" }).lean();
    if (rows.length === 1) ok("sending the same correction twice records it once");
    else bad("a replay records nothing new", `${rows.length} row(s)`);

    if (Array.isArray(again.body?.changed) && again.body.changed.length === 0) {
      ok("and the second answer says nothing changed");
    } else {
      bad("the replay reports no change", JSON.stringify(again.body?.changed));
    }
    if (first.status < 400 && again.status < 400) ok("both answered without an error");
    else bad("a replay is not an error", `${first.status} then ${again.status}`);
  }

  console.log("\n--- a correction and a correction back is real history ---");
  {
    await reset();
    await edit("adminA", { lastName: "Constance" });
    await edit("adminA", { lastName: "Constanse" });
    const rows = await History.find({ studentId: "st-1" }).sort({ changedAt: 1 }).lean();
    if (rows.length === 2) ok("two genuine changes are two rows, not deduplicated away");
    else bad("both steps are recorded", `${rows.length} row(s)`);
    if (rows[0]?.newValue === "Constance" && rows[1]?.newValue === "Constanse") {
      ok("in the order they happened");
    } else {
      bad("the order is preserved", rows.map((r) => r.newValue).join(" → "));
    }
  }

  // ── A first entry is not a change ─────────────────────────────────────────
  console.log("\n--- filling an empty field ---");
  {
    await reset();
    await edit("adminA", { city: "Bamenda" });
    const rows = await History.find({ studentId: "st-1", field: "city" }).lean();
    if (rows.length === 1 && rows[0].previousValue === null) {
      ok("recorded, with a null previous value rather than a fake one");
    } else {
      bad("filling an empty field records a null previous value",
        JSON.stringify(rows.map((r) => r.previousValue)));
    }
  }

  // ── Who may do it ────────────────────────────────────────────────────────
  console.log("\n--- who may correct a record ---");
  {
    await reset();
    const t = await edit("teacherA", { lastName: "Nope" });
    if (t.status === 403) ok("a teacher may not (403)");
    else bad("a teacher may not edit", `${t.status}`);

    const b = await edit("bursarA", { lastName: "Nope" });
    if (b.status === 403) ok("nor a bursar — they read the roster, they do not own it");
    else bad("a bursar may not edit", `${b.status}`);

    const s = await edit("student", { lastName: "Nope" });
    if (s.status === 403) ok("nor the pupil, through this route");
    else bad("a student may not use the admin route", `${s.status}`);

    const after = await Student.findById("st-1").lean();
    if (after.lastName === "Constanse") ok("and the record is untouched by any of them");
    else bad("the record is untouched", JSON.stringify(after.lastName));
  }

  console.log("\n--- and not across schools ---");
  {
    const r = await edit("adminB", { lastName: "Reached" }, "st-1");
    if (r.status === 403 || r.status === 404) ok(`another school's admin cannot reach it (${r.status})`);
    else bad("cross-school edit is refused", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    const after = await Student.findById("st-1").lean();
    if (after.lastName !== "Reached") ok("and the pupil's record did not move");
    else bad("the record did not move", JSON.stringify(after.lastName));
  }

  // ── What this route must not become ──────────────────────────────────────
  console.log("\n--- the fields this route refuses to be responsible for ---");
  {
    await reset();
    const r = await edit("adminA", {
      classId: "cls-b", status: "pending", isActive: false,
      enrollmentNo: "HACKED", schoolId: A,
    });
    const after = await Student.findById("st-1").lean();

    if (after.classId === "cls-a") ok("classId is ignored — moving a pupil also bills the new class");
    else bad("classId is ignored here", JSON.stringify(after.classId));

    if (after.status === "approved") ok("status is ignored — approve/suspend own that");
    else bad("status is ignored here", JSON.stringify(after.status));

    if (after.isActive !== false) ok("isActive is ignored");
    else bad("isActive is ignored here", JSON.stringify(after.isActive));

    if (after.enrollmentNo === "E-1") ok("enrollmentNo is ignored — it comes from a gapless counter");
    else bad("enrollmentNo is ignored here", JSON.stringify(after.enrollmentNo));

    if (String(after.schoolId) === A) ok("and schoolId cannot be moved at all");
    else bad("schoolId is immutable", JSON.stringify(after.schoolId));

    if (r.status === 400) ok("a save of nothing editable is refused rather than silently accepted");
    else bad("nothing-editable is a 400", `${r.status}`);
  }

  // ── Validation ───────────────────────────────────────────────────────────
  console.log("\n--- what it refuses to store ---");
  {
    await reset();
    const cases = [
      [{ dateOfBirth: "02/04/2011" }, "a date that is not YYYY-MM-DD"],
      [{ dateOfBirth: "2011-13-45" }, "a date that is not real"],
      [{ dateOfBirth: "2999-01-01" }, "a birth date in the future"],
      [{ gender: "unspecified" },     "a sex outside the schema's enum"],
      [{ email: "not-an-address" },   "an address that is not one"],
    ];
    for (const [patch, label] of cases) {
      const r = await edit("adminA", patch);
      if (r.status === 400) ok(label + " is refused");
      else bad(label + " is refused", `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    const after = await Student.findById("st-1").lean();
    if (after.dateOfBirth === "2011-04-02" && after.gender === "female") {
      ok("and nothing partial was written by any of them");
    } else {
      bad("a rejected save writes nothing",
        `${after.dateOfBirth} / ${after.gender}`);
    }
  }

  console.log("\n--- clearing a field is different from mistyping one ---");
  {
    await reset();
    const r = await edit("adminA", { guardianPhone: "" });
    const after = await Student.findById("st-1").lean();
    if (r.status < 400 && after.guardianPhone === null) {
      ok('an empty string clears to null — "we do not have one" is an answer');
    } else {
      bad("an empty value clears the field", `${r.status} ${JSON.stringify(after.guardianPhone)}`);
    }
  }

  // ── The pupil no longer rewrites their own identity ──────────────────────
  console.log("\n--- what a pupil may change about themselves ---");
  {
    await reset();
    const r = await call("student", "PUT", "/api/student/profile", {
      schoolId: A,
      firstName: "Renamed", lastName: "Themselves",
      dateOfBirth: "2000-01-01", gender: "male",
      phone: "677777777", address: "New address",
    });
    const after = await Student.findById("st-1").lean();

    if (r.status < 400) ok(`the profile save still succeeds (${r.status})`);
    else bad("the profile route still works", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (after.firstName === "Bern" && after.lastName === "Constanse") {
      ok("but the pupil's name is unchanged — identity is the office's to correct");
    } else {
      bad("a pupil cannot rename themselves",
        `${after.firstName} ${after.lastName}`);
    }
    if (after.dateOfBirth === "2011-04-02") ok("nor their date of birth");
    else bad("a pupil cannot change their date of birth", JSON.stringify(after.dateOfBirth));

    if (after.gender === "female") ok("nor their sex");
    else bad("a pupil cannot change their sex", JSON.stringify(after.gender));

    if (after.phone === "677777777" && after.address === "New address") {
      ok("while their own contact details still save, which is the half that is theirs");
    } else {
      bad("contact details still save", `${after.phone} / ${after.address}`);
    }

    if (after.studentName === "Bern Constanse") {
      ok("and the derived studentName did not drift either");
    } else {
      bad("the derived studentName is unchanged", JSON.stringify(after.studentName));
    }
  }

  // ── Reading it back ──────────────────────────────────────────────────────
  console.log("\n--- reading the history ---");
  {
    await reset();
    await edit("adminA", { lastName: "Constance", city: "Bamenda" });

    const r = await call("adminA", "GET", "/api/students/st-1/history?schoolId=" + A);
    if (r.status === 200) ok("an admin can read a pupil's correction history");
    else bad("the history is readable", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    const rows = r.body?.data?.changes ?? r.body?.changes ?? [];
    if (rows.length === 2) ok("and it lists both corrected fields");
    else bad("the history lists the changes", `${rows.length} row(s)`);

    const t = await call("teacherA", "GET", "/api/students/st-1/history?schoolId=" + A);
    if (t.status === 403) ok("a teacher cannot — previous names are more than the roster shows");
    else bad("the history needs students.viewFull", `${t.status}`);

    const cross = await call("adminB", "GET", "/api/students/st-1/history?schoolId=" + A);
    if (cross.status === 403 || cross.status === 404) {
      ok(`and another school cannot read it either (${cross.status})`);
    } else {
      bad("the history is school-scoped", `${cross.status}`);
    }
  }

  console.log("\n--- but a pupil may still COMPLETE an empty record ---");
  {
    /*
     * The half that nearly broke.
     *
     * app/student/profile/setup.js is a first-run wizard that requires a first
     * and last name. Refusing identity outright would have let a pupil fill the
     * form in and the name silently not save — worse than the hole being closed.
     * Empty stays fillable; set stays the office's.
     */
    await reset();
    await Student.updateOne(
      { _id: "st-1" },
      { $set: { firstName: null, lastName: null, dateOfBirth: null, gender: null,
                studentName: null } }
    );

    const r = await call("student", "PUT", "/api/student/profile", {
      schoolId: A,
      firstName: "Bern", lastName: "Constance",
      dateOfBirth: "2011-04-02", gender: "female",
    });
    const after = await Student.findById("st-1").lean();

    if (r.status < 400) ok(`the first-run wizard still saves (${r.status})`);
    else bad("the wizard still saves", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (after.firstName === "Bern" && after.lastName === "Constance") {
      ok("an empty name can be filled in by the pupil");
    } else {
      bad("an empty name can be filled in", `${after.firstName} ${after.lastName}`);
    }
    if (after.dateOfBirth === "2011-04-02") ok("so can an empty date of birth");
    else bad("an empty date of birth can be filled", JSON.stringify(after.dateOfBirth));
    if (after.gender === "female") ok("and an empty sex");
    else bad("an empty sex can be filled", JSON.stringify(after.gender));
    if (after.studentName === "Bern Constance") ok("and studentName follows the first fill");
    else bad("studentName follows the first fill", JSON.stringify(after.studentName));

    // And immediately afterwards the same pupil cannot change any of them.
    await call("student", "PUT", "/api/student/profile", {
      schoolId: A, firstName: "Someone", lastName: "Else", gender: "male",
      dateOfBirth: "2000-01-01",
    });
    const again = await Student.findById("st-1").lean();
    if (again.firstName === "Bern" && again.lastName === "Constance" &&
        again.gender === "female" && again.dateOfBirth === "2011-04-02") {
      ok("once set, the pupil cannot change it — filling is not the same as rewriting");
    } else {
      bad("a filled field cannot then be rewritten",
        `${again.firstName} ${again.lastName} / ${again.gender} / ${again.dateOfBirth}`);
    }

    const rubbish = await call("student", "PUT", "/api/student/profile", {
      schoolId: A, phone: "690000001",
    });
    if (rubbish.status < 400) ok("and an ordinary contact update is unaffected by any of it");
    else bad("contact updates still work", `${rubbish.status}`);
  }

  // ── The form has to be able to SHOW what it edits ───────────────────────
  //
  // The bug this closes: the edit form was built on GET /admin/students/:id and
  // its name boxes came up empty. Two normalisers sit between the document and
  // the form — shared/students.js collapses firstName and lastName into `name`
  // and omits seven other editable fields, and the web client's own normaliser
  // then drops firstName and lastName as well. Between them the form could be
  // pre-filled with seven of eighteen fields.
  //
  // A form that shows a blank box for data the school holds invites somebody to
  // retype it, or to read the blank as "we never collected this". So there is a
  // read that returns exactly what the write accepts, and this asserts the two
  // agree — which is the assertion that was missing when it shipped.
  console.log("\n--- the form can show every field it can edit ---");
  {
    await reset();
    await Student.updateOne({ _id: "st-1" }, { $set: {
      alternatePhone: "690111222", city: "Bamenda", state: "North West",
      nationalId: "ID-1", guardianRelation: "mother", bloodGroup: "O+",
      medicalConditions: "asthma", notes: "office note",
      guardianName: "A Guardian", guardianEmail: "g@example.test",
      email: "pupil@example.test", phone: "670000111", address: "Some street",
    } });

    const r = await call("adminA", "GET", `/api/students/st-1/editable?schoolId=${A}`);
    if (r.status === 200) ok("the form's own read answers");
    else bad("the editable read answers", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    const got = r.body?.data ?? r.body ?? {};

    // Read the server's own list rather than restating it here: a field added
    // to EDITABLE_FIELDS and forgotten in the read would otherwise pass.
    const fs2 = require("fs");
    const routeSrc = fs2.readFileSync(path.join(SRC, "routes", "students.routes.js"), "utf8");
    const m = routeSrc.match(/const EDITABLE_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\);/);
    const serverFields = m ? [...m[1].matchAll(/^[ \t]+([a-zA-Z]+):/gm)].map((x) => x[1]) : [];

    const absent = serverFields.filter((f) => !(f in got));
    if (absent.length === 0) {
      ok(`every one of the ${serverFields.length} editable fields is present in the read`);
    } else {
      bad("the read carries every editable field", "absent: " + absent.join(", "));
    }

    // The specific thing the user saw.
    if (got.firstName === "Bern" && got.lastName === "Constanse") {
      ok("the name arrives as first and last, not collapsed into one display string");
    } else {
      bad("the name arrives in parts",
        `firstName=${JSON.stringify(got.firstName)} lastName=${JSON.stringify(got.lastName)}`);
    }

    // The seven the shared projection drops.
    const dropped = {
      alternatePhone: "690111222", city: "Bamenda", state: "North West",
      nationalId: "ID-1", guardianRelation: "mother", bloodGroup: "O+",
      medicalConditions: "asthma",
    };
    const wrong = Object.entries(dropped).filter(([k, v]) => got[k] !== v);
    if (wrong.length === 0) {
      ok("and so do the seven fields the display projection omits");
    } else {
      bad("the fields the display projection omits are present",
        wrong.map(([k, v]) => `${k}: expected ${v}, got ${JSON.stringify(got[k])}`).join("; "));
    }

    if (typeof got.dateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(got.dateOfBirth)) {
      ok("the date of birth comes back in the format the save requires");
    } else {
      bad("dateOfBirth round-trips in YYYY-MM-DD", JSON.stringify(got.dateOfBirth));
    }

    if (got.updatedAt) ok("with the updatedAt the form sends back for overwrite detection");
    else bad("updatedAt is included", JSON.stringify(got.updatedAt));

    // Same guard as the write: reading a record for editing is half of editing.
    const t2 = await call("teacherA", "GET", `/api/students/st-1/editable?schoolId=${A}`);
    if (t2.status === 403) ok("a teacher cannot load it, as they cannot save it");
    else bad("the editable read needs students.manage", `${t2.status}`);

    const x = await call("adminB", "GET", `/api/students/st-1/editable?schoolId=${A}`);
    if (x.status === 403 || x.status === 404) ok(`and another school cannot (${x.status})`);
    else bad("the editable read is school-scoped", `${x.status}`);
  }

  // ── The three lists that must not drift ─────────────────────────────────
  //
  // The server's EDITABLE_FIELDS is the security boundary. The web page and the
  // desktop offline handler each keep their own copy, deliberately — neither
  // should be able to widen what the server accepts by agreeing with itself.
  // But a field added to one and forgotten in another is invisible until
  // somebody edits it and the change quietly does not save.
  //
  // Read out of the source rather than imported: the web page is TSX and the
  // desktop handler wants an Electron-shaped context, so neither can be
  // required from here.
  console.log("\n--- the client lists match the server's ---");
  {
    const fs = require("fs");
    const read = (...parts) => {
      try { return fs.readFileSync(path.join(...parts), "utf8"); }
      catch { return null; }
    };
    const names = (text, re, inner) => {
      const m = text && text.match(re);
      return m ? [...m[1].matchAll(inner)].map((x) => x[1]) : [];
    };

    const serverFields = names(
      read(SRC, "routes", "students.routes.js"),
      /const EDITABLE_FIELDS = Object\.freeze\(\{([\s\S]*?)\}\);/,
      /^[ \t]+([a-zA-Z]+):/gm
    );

    if (serverFields.length >= 15) {
      ok(`the server declares ${serverFields.length} editable fields`);
    } else {
      bad("the server declares its editable fields", serverFields.join(", "));
    }

    const compare = (label, fields, what) => {
      if (fields.length === 0) { bad(`${what} declares its field list`, "none found"); return; }
      const extra   = fields.filter((f) => !serverFields.includes(f));
      const missing = serverFields.filter((f) => !fields.includes(f));
      if (extra.length === 0) ok(`${label} offers no field the server would drop`);
      else bad(`${label} offers only server-editable fields`, extra.join(", "));
      if (missing.length === 0) ok(`and covers the server's list, so it is not silently narrower`);
      else bad(`${label} covers the server's list`, "missing: " + missing.join(", "));
    };

    compare(
      "the web form",
      names(
        read(ROOT, "..", "web", "src", "pages", "students", "EditStudentPage.tsx"),
        /type FieldName =([\s\S]*?);/,
        /"([a-zA-Z]+)"/g
      ),
      "the web edit page"
    );

    compare(
      "the desktop handler",
      names(
        read(ROOT, "..", "desktop", "src", "main", "api", "writes", "students.js"),
        /const EDITABLE = \[([\s\S]*?)\];/,
        /"([a-zA-Z]+)"/g
      ),
      "the desktop write handler"
    );
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
