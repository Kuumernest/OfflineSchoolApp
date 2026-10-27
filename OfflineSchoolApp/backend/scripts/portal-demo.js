// backend/scripts/portal-demo.js
"use strict";

/**
 * A throwaway parent portal to look at: an in-memory database seeded with one
 * guardian (Mrs Bate) and her three children, then the real backend on it.
 *
 * For screenshots and design work only (docs/parent-portal/). Nothing here
 * touches a real database: MongoMemoryServer, gone when the process stops.
 *
 *   node scripts/portal-demo.js [--out <file>]
 *
 * Listens on PORT (default 5000, where the web dev server proxies /api) and
 * writes the parent's sign-in — { admissionNo, code } — to --out (default
 * portal-demo-login.json in the OS temp dir).
 *
 * The children, chosen to light every state of every screen:
 *   Eve  Form 1        improving; one fee overdue; one absence this month
 *   Fay  Form 3        falling; fee due in a fortnight; full attendance
 *   Gus  Lower Sixth   steady; fees paid in full; a late arrival
 */

const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const mongoose = require("mongoose");

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : path.join(os.tmpdir(), "portal-demo-login.json");
})();

const DAY  = 86_400_000;
const now  = new Date();
const iso  = (d) => d.toISOString().slice(0, 10);
const days = (n) => new Date(now.getTime() + n * DAY);
const YEAR = "2026/2027";

/** sum(mark × coef) / sum(coef) — the school's one average (shared/averages.js). */
const average = (rows) => {
  const c = rows.reduce((s, r) => s + r.coefficient, 0);
  return Math.round((rows.reduce((s, r) => s + r.normalizedMark * r.coefficient, 0) / c) * 100) / 100;
};

const REMARK = (m) => m >= 16 ? "Very good" : m >= 14 ? "Good" : m >= 12 ? "Fairly good" : m >= 10 ? "Average" : "Weak";

const SUBJECTS = [
  ["MAT", "Mathematics", 5], ["ENG", "English Language", 4], ["FRE", "French", 4],
  ["PHY", "Physics", 3], ["BIO", "Biology", 3], ["HIS", "History", 2], ["GEO", "Geography", 2],
];

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  process.env.MONGODB_URI = mongo.getUri("portal-demo");
  process.env.MONGO_URI   = process.env.MONGODB_URI;
  process.env.PORT        = process.env.PORT || "5000";
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "portal-demo-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "portal-demo-refresh-secret";
  process.env.NODE_ENV    = process.env.NODE_ENV || "development";

  await mongoose.connect(process.env.MONGODB_URI);
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const S = new mongoose.Types.ObjectId();
  const sid = String(S);
  await M("School").collection.insertOne({
    _id: S, name: "Bright Future College", code: "BFC", city: "Bamenda", region: "North West",
    isActive: true, deletedAt: null, settings: { academicYear: YEAR, currentTerm: "Second Term", currency: "XAF" },
  });
  await M("GradingConfig").create({ schoolId: sid, passMark: 10 });

  const classes = [["c-f1", "Form 1"], ["c-f3", "Form 3"], ["c-ls", "Lower Sixth"]];
  await M("Class").collection.insertMany(classes.map(([_id, name]) => ({ _id, schoolId: sid, name, isActive: true, deletedAt: null })));

  await M("User").create({
    _id: "t-ngwa", name: "Mr Ngwa", email: "ngwa@demo.test", password: "Demo-passw0rd",
    role: "teacher", schoolId: sid, isActive: true,
  });

  const kids = [
    { _id: "eve", studentName: "Eve Bate", classId: "c-f1", className: "Form 1",      enrollmentNo: "BFC-2026-014", trend: [11.2, 12.4, 14.4], pos: [12, 8, 3] },
    { _id: "fay", studentName: "Fay Bate", classId: "c-f3", className: "Form 3",      enrollmentNo: "BFC-2025-031", trend: [15.1, 14.0, 12.2], pos: [4, 7, 15] },
    { _id: "gus", studentName: "Gus Bate", classId: "c-ls", className: "Lower Sixth", enrollmentNo: "BFC-2023-007", trend: [13.0, 13.4, 13.2], pos: [9, 8, 9] },
  ];
  for (const k of kids) {
    await M("Student").collection.insertOne({
      _id: k._id, schoolId: sid, classId: k.classId, className: k.className, studentName: k.studentName,
      enrollmentNo: k.enrollmentNo, admissionNo: k.enrollmentNo, status: "approved", isActive: true, deletedAt: null,
      guardianName: "Mrs Bate", guardianPhone: "+237670000001", guardianEmail: "bate@example.test",
    });
    await M("TeacherAssignment").create({ schoolId: sid, teacher: "t-ngwa", class: k.classId, subject: "MAT", isActive: true });
  }

  // Three sequences: two in term 1, one in term 2; the next one scheduled.
  const exams = [["seq1", "1st Sequence", 1, 1, -70], ["seq2", "2nd Sequence", 1, 2, -40], ["seq3", "3rd Sequence", 2, 3, -12]];
  for (const k of kids) {
    for (const [i, [eid, name, term, seq, offset]] of exams.entries()) {
      const examId = `${eid}-${k.classId}`;
      await M("Exam").collection.insertOne({
        _id: examId, schoolId: sid, classId: k.classId, classIds: [k.classId], className: k.className, name, type: "test",
        academicYear: YEAR, term, sequenceNumber: seq, startDate: iso(days(offset)), endDate: iso(days(offset + 4)),
        status: "published", resultsPublished: true, resultsPublishedAt: days(offset + 10), deletedAt: null,
      });
      const target = k.trend[i];
      const subjects = SUBJECTS.map(([subjectId, subjectName, coefficient], j) => {
        const mark = Math.max(4, Math.min(19.5, Math.round((target + ((j * 7) % 5) - 2) * 2) / 2));
        return {
          subjectId, subjectName, coefficient, score: mark, maxScore: 20, normalizedMark: mark,
          weightedMark: mark * coefficient, remark: REMARK(mark), isPassing: mark >= 10, isAbsent: false,
        };
      });
      await M("ResultSummary").create({
        examId, studentId: k._id, classId: k.classId, className: k.className, schoolId: sid,
        academicYear: YEAR, term: String(term), average: average(subjects), percentage: average(subjects) * 5,
        classPosition: k.pos[i], totalInClass: 42, isPassing: average(subjects) >= 10,
        overallRemark: REMARK(average(subjects)), subjectBreakdown: subjects,
        subjectsTotal: subjects.length, subjectsPassed: subjects.filter((s) => s.isPassing).length,
        subjectsFailed: subjects.filter((s) => !s.isPassing).length,
        isPublished: true, publishedAt: days(offset + 10), calcVersion: "exam-process/3",
      });
      // The card the school issued (2nd and 3rd Sequence); the 1st was never
      // printed, so the portal's "not issued yet" state shows too.
      if (i > 0) {
        await M("GeneratedReport").collection.insertOne({
          schoolId: sid, examId, studentId: k._id, templateVersion: 1, deletedAt: null, updatedAt: days(offset + 10),
          renderedHtml: `<!doctype html><html><body style="font-family:sans-serif;padding:32px"><h1>Bright Future College</h1>` +
            `<h2>${name} — ${k.studentName} (${k.className})</h2><p>Average: ${average(subjects).toFixed(2)}/20 · ` +
            `Position ${k.pos[i]} of 42</p><table border="1" cellpadding="6">${subjects.map((x) =>
              `<tr><td>${x.subjectName}</td><td>${x.normalizedMark}/20</td><td>×${x.coefficient}</td><td>${x.remark}</td></tr>`).join("")}</table></body></html>`,
        });
      }
    }
    await M("Exam").collection.insertOne({
      _id: `seq4-${k.classId}`, schoolId: sid, classId: k.classId, classIds: [k.classId], className: k.className,
      name: "4th Sequence", type: "test", academicYear: YEAR, term: 2, sequenceNumber: 4,
      startDate: iso(days(9)), endDate: iso(days(13)), status: "scheduled", resultsPublished: false, deletedAt: null,
    });
  }

  // Fees: Eve owes and is overdue; Fay owes, due in a fortnight; Gus is paid up.
  const fee = (studentId, code, label, amount, due) => M("FeeCharge").create({
    schoolId: sid, studentId, academicYear: YEAR, code, label, amount, dueDate: due,
  });
  let receipt = 100;
  const pay = (studentId, amount, when, method = "mobile_money") => M("FeePayment").create({
    schoolId: sid, studentId, academicYear: YEAR, amount, receivedAt: when, method, receiptNo: `RCP-2026-${++receipt}`,
  });
  for (const k of kids) {
    await fee(k._id, "T1", "Tuition — First Term", 85000, days(-60));
    await pay(k._id, 85000, days(-62));
  }
  await fee("eve", "T2", "Tuition — Second Term", 85000, days(-6));
  await fee("eve", "PTA", "PTA levy", 10000, days(-6));
  await pay("eve", 40000, days(-20));
  await fee("fay", "T2", "Tuition — Second Term", 85000, days(14));
  await pay("fay", 50000, days(-3), "cash");
  await fee("gus", "T2", "Tuition — Second Term", 95000, days(-6));
  await pay("gus", 95000, days(-10));

  // Attendance this month: school days only, one record per day.
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let d = new Date(start); d <= now; d = new Date(d.getTime() + DAY)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    for (const k of kids) {
      const day = iso(d);
      let status = "present";
      if (k._id === "eve" && d.getDate() === 13) status = "absent";
      if (k._id === "gus" && d.getDate() === 20) status = "late";
      await M("StudentAttendance").collection.insertOne({
        schoolId: sid, classId: k.classId, subjectId: null, period: "p1", studentId: k._id,
        date: day, status, markedBy: "t-ngwa", createdAt: d, updatedAt: d,
      });
    }
  }

  const announce = (title, body, ago) => M("Announcement").create({
    schoolId: sid, title, body, audience: "all", isActive: true, authorName: "The Principal", authorRole: "school_admin",
    createdAt: days(-ago),
  });
  await announce("Second term report cards", "Report cards for the 3rd Sequence are now available on the portal. Please review them with your child.", 2);
  await announce("Sports day — Friday 6 November", "Parents are welcome from 9:00. Pupils should come in their house colours.", 5);
  await announce("PTA general meeting", "The PTA meets on Saturday at 10:00 in the main hall. Agenda: second-term levies and the new library.", 12);

  const notice = (studentId, kind, subject, body, ago) => M("Notification").collection.insertOne({
    schoolId: sid, studentId, kind, channel: "log", to: "bate@example.test", subject, body,
    status: "sent", deletedAt: null, readBy: [], createdAt: days(-ago), updatedAt: days(-ago),
  });
  await notice("eve", "fee.reminder", "Fee reminder — Eve Bate", "85,000 FCFA was due on the school's second-term date. Please contact the bursar.", 1);
  await notice("eve", "result.published", "3rd Sequence results published", "Eve Bate's 3rd Sequence results are available.", 2);
  await notice("fay", "result.published", "3rd Sequence results published", "Fay Bate's 3rd Sequence results are available.", 2);
  await notice("eve", "attendance.absent", "Absence recorded", "Eve Bate was marked absent on the 13th.", 14);

  const portal = require("../src/services/portal.service");
  const { code } = await portal.issueAccess({ schoolId: sid, studentIds: kids.map((k) => k._id), label: "Mrs Bate" });
  await mongoose.disconnect();

  fs.writeFileSync(OUT, JSON.stringify({ admissionNo: kids[0].enrollmentNo, code }, null, 2));
  console.log(`[portal-demo] seeded; sign-in written to ${OUT}`);

  require("../src/server.js");

  const stop = async () => { await mongo.stop().catch(() => {}); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((err) => { console.error("[portal-demo]", err); process.exit(1); });
