// backend/src/services/compliance.service.js
"use strict";

/**
 * Fee compliance from the database: loads a pupil's facts for the school's
 * current year and hands them to shared/compliance.js, which decides.
 *
 * The same facts, minus everything a gate has no business seeing, are what
 * GET /api/gate/snapshot sends a gate device (factsFor) — so the device's
 * offline answer and this one are the same function over the same inputs.
 */

const FeeCharge         = require("../db/models/FeeCharge");
const FeePayment        = require("../db/models/FeePayment");
const PaymentPlan       = require("../db/models/PaymentPlan");
const GateAuthorization = require("../db/models/GateAuthorization");
const { currentYearOf } = require("./fees.service");
const { yearForms }     = require("./rankingScope.service");
const { compliance }    = require("../../../shared/compliance");

const group = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const k = String(r.studentId);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return by;
};

/** A plan reduced to what the engine reads — no reason, notes, history or people. */
const planFacts = (p) => p && ({
  _id: String(p._id),
  status: p.status, approvalStatus: p.approvalStatus ?? null,
  academicYear: p.academicYear, term: p.term ?? null,
  instalments: (p.instalments ?? []).map((i) => ({ seq: i.seq, amount: i.amount, dueDate: i.dueDate })),
  basis: p.basis ?? null, baselinePaid: p.baselinePaid ?? 0, agreedTotal: p.agreedTotal ?? null,
  effectiveFrom: p.effectiveFrom ?? null, expiresAt: p.expiresAt ?? null,
  hasPendingChange: Boolean(p.pendingChange),
});

/**
 * Which plan to judge a pupil by when there are several (one per term is
 * allowed): an approved one in force first, otherwise the newest active one —
 * which the engine will then report as pending/outside its dates.
 */
const pickPlan = (plans, asOf) => {
  const { isPlanApplicable } = require("../../../shared/arrears");
  const live = (plans ?? []).filter((p) => p.status === "active" && !p.deletedAt);
  return live.find((p) => isPlanApplicable(p, asOf))
    ?? live.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0))[0]
    ?? null;
};

/**
 * The fee facts for a set of pupils in one school's current year.
 *
 * @returns {Promise<{ academicYear: string|null, facts: Map<string, {charges, payments, plan, authorizations}> }>}
 */
async function factsFor({ schoolId, studentIds, academicYear = null, asOf = new Date() }) {
  schoolId = String(schoolId);
  const year = academicYear || await currentYearOf(schoolId);
  const ids  = [...new Set((studentIds ?? []).map(String))];
  const facts = new Map(ids.map((id) => [id, { charges: [], payments: [], plan: null, authorizations: [] }]));
  if (!ids.length) return { academicYear: year, facts };

  const inYear = year ? { academicYear: { $in: yearForms(year) } } : {};
  const scope  = { schoolId, studentId: { $in: ids } };

  const [charges, payments, plans, auths] = await Promise.all([
    year ? FeeCharge.find({ ...scope, ...inYear, voidedAt: null, deletedAt: null })
      .select("studentId amount waivedAmount dueDate createdAt").lean() : [],
    year ? FeePayment.find({ ...scope, ...inYear, deletedAt: null })
      .select("studentId amount receivedAt").lean() : [],
    year ? PaymentPlan.find({ ...scope, ...inYear, status: "active", deletedAt: null }).lean() : [],
    // Passes that have not ended yet (a pass for next week is sent too, so a
    // device offline over the weekend still knows about Monday's).
    GateAuthorization.find({
      ...scope, revokedAt: null, deletedAt: null,
      validUntil: { $gte: new Date(new Date(asOf).getTime() - 86_400_000) },
    }).select("studentId validFrom validUntil reason grantedBy").lean(),
  ]);

  const c = group(charges), pay = group(payments), pl = group(plans), au = group(auths);
  for (const id of ids) {
    const f = facts.get(id);
    f.charges = (c.get(id) ?? []).map((x) => ({ amount: x.amount, waivedAmount: x.waivedAmount ?? 0, dueDate: x.dueDate ?? null, createdAt: x.createdAt }));
    // Server rows are confirmed by definition. The id lets a device tell a
    // payment it holds as synced from one the snapshot already counts, so a
    // payment confirmed after the snapshot was made is not lost until the
    // next pull, nor counted twice.
    f.payments = (pay.get(id) ?? []).map((x) => ({ _id: String(x._id), amount: x.amount, receivedAt: x.receivedAt ?? null }));
    f.plan = planFacts(pickPlan(pl.get(id), asOf));
    f.authorizations = (au.get(id) ?? []).map((a) => ({
      _id: String(a._id), validFrom: a.validFrom, validUntil: a.validUntil,
      reason: a.reason, grantedBy: a.grantedBy ?? null,
    }));
  }
  return { academicYear: year, facts };
}

/** One pupil's compliance, live from the database. */
async function complianceFor({ schoolId, studentId, asOf = new Date() }) {
  const { academicYear, facts } = await factsFor({ schoolId, studentIds: [studentId], asOf });
  const f = facts.get(String(studentId));
  return { academicYear, ...compliance({ ...f, asOf }) };
}

module.exports = { factsFor, complianceFor, planFacts };
