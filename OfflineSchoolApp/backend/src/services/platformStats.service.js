// backend/src/services/platformStats.service.js
"use strict";

const School       = require("../db/models/School");
const Student      = require("../db/models/Student");
const User         = require("../db/models/User");
const TermResult   = require("../db/models/TermResult");
const AnnualResult = require("../db/models/AnnualResult");
const FeeCharge    = require("../db/models/FeeCharge");
const { outstandingBySchool } = require("./fees.service");
const { currentAcademicYearOf, yearKey } = require("../../../shared/academicYear");
const { DEFAULT_PASS_MARK } = require("../../../shared/passRate");
const { StudentAttendance } = require("../db/models/Attendance");

/**
 * The figures across every school, from the collections that already hold
 * them. Nothing here is a new metric; each number below is the same count the
 * matching school-level screen already shows, grouped by schoolId instead of
 * filtered to one.
 *
 * ── What each figure means, stated so the dashboard can say so ────────────
 *
 *   students     Student rows with status "approved" and not deleted — the
 *                same as the admin dashboard's "approved".
 *   teachers     active Users with role teacher.
 *   attendance   register rows in a window of days (default the last 30).
 *                `rate` is present ÷ marked: the share of register entries
 *                that were "present". Late and excused are shown separately
 *                and are NOT in the numerator, matching /admin/attendance/stats.
 *   academics    TermResult rows (not deleted, with an average): count, mean
 *                termAverage, and passRate = term averages at or above the
 *                school's pass mark ÷ count (shared/passRate.js). The chosen
 *                year, else each school's current year; the term if given.
 *   promotion    AnnualResult rows by promotionStatus. `rate` is
 *                (promoted + graduated) ÷ decided, where decided excludes
 *                "pending" — an undecided pupil is not a failed one.
 *   fees         fees.service outstandingBySchool — the figure Fees >
 *                Outstanding and Financial reports show: current students
 *                (approved, active, not deleted), the chosen year or else each
 *                school's current year. charged/waived/paid are theirs;
 *                balance is the sum of positive balances (outstanding).
 *                billed = charged − waived; collectionRate = paid ÷ billed.
 *
 * ── Filters ──────────────────────────────────────────────────────────────
 *
 *   schoolId      one school, or all of them
 *   academicYear  results, promotion and fees carry one; attendance does not
 *   term          1–3, results only. FeeCharge.term is a free label ("First
 *                 Term", "Term 1") that no two schools spell the same, so it
 *                 is not filtered rather than filtered wrongly.
 *   from / to     attendance window, YYYY-MM-DD
 *
 * Nothing is invented: a school with no rows in a collection shows 0 and a
 * null rate, never a made-up 100%.
 */

const DAY_MS = 86_400_000;

const dayString = (d) => d.toISOString().slice(0, 10);
const isDay     = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
const round1    = (n) => Math.round(n * 10) / 10;
const pct       = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
const sumBy     = (rows, f) => rows.reduce((acc, r) => acc + (f(r) || 0), 0);

/** Read and sanitise the filters off a query string. */
const parseFilters = (q = {}) => {
  const schoolId     = q.schoolId ? String(q.schoolId).trim() : null;
  const academicYear = q.academicYear ? String(q.academicYear).trim() : null;
  const termRaw      = q.term != null && q.term !== "" ? Number(q.term) : null;
  const term         = Number.isInteger(termRaw) && termRaw >= 1 && termRaw <= 3 ? termRaw : null;

  const today = new Date();
  const to    = isDay(q.to)   ? String(q.to)   : dayString(today);
  const from  = isDay(q.from) ? String(q.from) : dayString(new Date(today.getTime() - 29 * DAY_MS));

  return { schoolId, academicYear, term, from, to };
};

const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const statusIs = (field, value) => ({ $eq: [`$${field}`, value] });

const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));

/**
 * @param {ReturnType<typeof parseFilters>} filters
 * @returns {Promise<{filters:object,totals:object,schools:object[]}>}
 */
const computePlatformStats = async (filters) => {
  const { schoolId, academicYear, term, from, to } = filters;

  const sf = schoolId     ? { schoolId }     : {};
  const yr = academicYear ? { academicYear } : {};
  const tm = term         ? { term }         : {};

  const allSchools = await School.find(School.notDeletedClause())
    .select("_id name code isActive settings.academicYear settings.currentTerm createdAt")
    .sort({ name: 1 })
    .lean();
  const schools = schoolId
    ? allSchools.filter((s) => String(s._id) === schoolId)
    : allSchools;

  // Results are read for one year per school: the chosen one, else the
  // school's own current year.
  const yearScope = schools.map((s) => {
    const year = academicYear ? yearKey(academicYear) : currentAcademicYearOf(s);
    return { schoolId: String(s._id), academicYear: { $in: [year, year.replace("/", "-")] } };
  });
  if (!yearScope.length) yearScope.push({ schoolId: null });

  const [students, teachers, attendance, results, annual, owed] =
    await Promise.all([
      Student.aggregate([
        { $match: { ...sf, deletedAt: null, status: "approved" } },
        { $group: { _id: "$schoolId", n: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { ...sf, role: "teacher", isActive: true } },
        { $group: { _id: "$schoolId", n: { $sum: 1 } } },
      ]),
      StudentAttendance.aggregate([
        { $match: { ...sf, date: { $gte: from, $lte: to } } },
        { $group: {
          _id:     "$schoolId",
          marked:  { $sum: 1 },
          present: countIf(statusIs("status", "present")),
          late:    countIf(statusIs("status", "late")),
          absent:  countIf(statusIs("status", "absent")),
          excused: countIf(statusIs("status", "excused")),
        } },
      ]),
      // The one pass rate (shared/passRate.js): a term average /20 against
      // that school's own pass mark, over the term results that have an
      // average, in the chosen year — else each school's current year (it
      // was every term of every year, by a stored flag).
      TermResult.aggregate([
        { $match: { ...tm, deletedAt: null, termAverage: { $ne: null }, $or: yearScope } },
        { $lookup: { from: "gradingconfigs", localField: "schoolId", foreignField: "schoolId", as: "gc" } },
        { $addFields: { passMark: { $ifNull: [{ $arrayElemAt: ["$gc.passMark", 0] }, DEFAULT_PASS_MARK] } } },
        { $group: {
          _id:       "$schoolId",
          n:         { $sum: 1 },
          sum:       { $sum: "$termAverage" },
          passing:   countIf({ $gte: ["$termAverage", "$passMark"] }),
          published: countIf({ $eq: ["$isPublished", true] }),
        } },
      ]),
      AnnualResult.aggregate([
        { $match: { ...sf, ...yr, deletedAt: null } },
        { $group: {
          _id:         "$schoolId",
          n:           { $sum: 1 },
          promoted:    countIf(statusIs("promotionStatus", "promoted")),
          repeated:    countIf(statusIs("promotionStatus", "repeated")),
          conditional: countIf(statusIs("promotionStatus", "conditional")),
          graduated:   countIf(statusIs("promotionStatus", "graduated")),
          pending:     countIf(statusIs("promotionStatus", "pending")),
        } },
      ]),
      // The one outstanding figure (fees.service outstandingBySchool), the
      // same as Fees > Outstanding and Financial reports: current students,
      // the chosen year or else each school's current year, positive
      // balances only. This summed every charge in the school, in every
      // year unless one was chosen, and netted credits against debts.
      outstandingBySchool({ schoolIds: schools.map((s) => String(s._id)), academicYear: academicYear || null }),
    ]);

  const st = byId(students), te = byId(teachers), at = byId(attendance);
  const re = byId(results),  an = byId(annual);

  const rowFor = (s) => {
    const id = String(s._id);
    const a = at.get(id), r = re.get(id), p = an.get(id), f = owed.get(id);

    const marked   = a?.marked ?? 0;
    const present  = a?.present ?? 0;
    const nResults = r?.n ?? 0;
    const decided  = (p?.n ?? 0) - (p?.pending ?? 0);
    const promotedOrGraduated = (p?.promoted ?? 0) + (p?.graduated ?? 0);
    const charged  = f?.charged ?? 0;
    const waived   = f?.waived ?? 0;
    const billed   = charged - waived;
    const paid     = f?.paid ?? 0;

    return {
      schoolId:     id,
      name:         s.name,
      code:         s.code ?? null,
      isActive:     s.isActive !== false,
      academicYear: s.settings?.academicYear ?? null,
      currentTerm:  s.settings?.currentTerm  ?? null,
      students:     st.get(id)?.n ?? 0,
      teachers:     te.get(id)?.n ?? 0,
      attendance: {
        marked, present,
        late:    a?.late ?? 0,
        absent:  a?.absent ?? 0,
        excused: a?.excused ?? 0,
        rate:    pct(present, marked),
      },
      academics: {
        results:   nResults,
        published: r?.published ?? 0,
        average:   nResults > 0 ? round1((r?.sum ?? 0) / nResults) : null,
        passRate:  pct(r?.passing ?? 0, nResults),
        academicYear: academicYear ? yearKey(academicYear) : currentAcademicYearOf(s),
      },
      promotion: {
        decided,
        promoted:    p?.promoted ?? 0,
        repeated:    p?.repeated ?? 0,
        conditional: p?.conditional ?? 0,
        graduated:   p?.graduated ?? 0,
        pending:     p?.pending ?? 0,
        rate:        pct(promotedOrGraduated, decided),
      },
      fees: {
        academicYear: f?.academicYear ?? null,
        charged, waived, billed, paid,
        // Outstanding: what current students owe, positive balances only.
        balance:        f?.outstanding ?? 0,
        owing:          f?.owing ?? 0,
        collectionRate: pct(paid, billed),
      },
    };
  };

  const rows = schools.map(rowFor);

  const marked   = sumBy(rows, (r) => r.attendance.marked);
  const present  = sumBy(rows, (r) => r.attendance.present);
  const nResults = sumBy(rows, (r) => r.academics.results);
  const resultSum = sumBy(rows, (r) => (re.get(r.schoolId)?.sum ?? 0));
  const passing  = sumBy(rows, (r) => (re.get(r.schoolId)?.passing ?? 0));
  const decided  = sumBy(rows, (r) => r.promotion.decided);
  const promoted = sumBy(rows, (r) => r.promotion.promoted + r.promotion.graduated);
  const billed   = sumBy(rows, (r) => r.fees.billed);
  const paid     = sumBy(rows, (r) => r.fees.paid);

  const totals = {
    schools:       rows.length,
    activeSchools: rows.filter((r) => r.isActive).length,
    students:      sumBy(rows, (r) => r.students),
    teachers:      sumBy(rows, (r) => r.teachers),
    attendance: {
      marked, present,
      late:    sumBy(rows, (r) => r.attendance.late),
      absent:  sumBy(rows, (r) => r.attendance.absent),
      excused: sumBy(rows, (r) => r.attendance.excused),
      rate:    pct(present, marked),
    },
    academics: {
      results:   nResults,
      published: sumBy(rows, (r) => r.academics.published),
      average:   nResults > 0 ? round1(resultSum / nResults) : null,
      passRate:  pct(passing, nResults),
    },
    promotion: {
      decided,
      promoted:    sumBy(rows, (r) => r.promotion.promoted),
      repeated:    sumBy(rows, (r) => r.promotion.repeated),
      conditional: sumBy(rows, (r) => r.promotion.conditional),
      graduated:   sumBy(rows, (r) => r.promotion.graduated),
      pending:     sumBy(rows, (r) => r.promotion.pending),
      rate:        pct(promoted, decided),
    },
    fees: {
      charged: sumBy(rows, (r) => r.fees.charged),
      waived:  sumBy(rows, (r) => r.fees.waived),
      billed, paid,
      balance:        sumBy(rows, (r) => r.fees.balance),
      owing:          sumBy(rows, (r) => r.fees.owing),
      collectionRate: pct(paid, billed),
    },
  };

  return {
    filters: { ...filters, termAppliesTo: ["academics"] },
    totals,
    schools: rows,
  };
};

/** What the filter controls can offer: the years that actually have data. */
const availableFilters = async () => {
  const [a, b, c, schools] = await Promise.all([
    TermResult.distinct("academicYear",   { deletedAt: null }),
    AnnualResult.distinct("academicYear", { deletedAt: null }),
    FeeCharge.distinct("academicYear",    { deletedAt: null }),
    School.find(School.notDeletedClause()).select("_id name isActive").sort({ name: 1 }).lean(),
  ]);
  const academicYears = [...new Set([...a, ...b, ...c].filter(Boolean).map(String))]
    .sort()
    .reverse();
  return {
    academicYears,
    terms: [1, 2, 3],
    schools: schools.map((s) => ({ _id: String(s._id), name: s.name, isActive: s.isActive !== false })),
  };
};

module.exports = { parseFilters, computePlatformStats, availableFilters };
