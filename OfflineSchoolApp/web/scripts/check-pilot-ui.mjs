// web/scripts/check-pilot-ui.mjs
//
// Stage 18 on the web: the operator-facing readiness screen and the report
// on the intelligence review page. Static: reads the source and the locales,
// no browser.
//
//   - the service calls the report route, sends four attestations, and an
//     amendment cannot be typed without a reason
//   - the page renders five readiness groups, each READY / BLOCKED /
//     REQUIRES CONFIRMATION, and the open button stays disabled until the
//     server says ready AND all four confirmations are signed
//   - the blocked line is the server's missing list, in words
//   - a finding is amended only with a reason; CALIBRATED is not offered
//     while an engine drifted
//   - the report renders outcomes, the four concerns, the explanation
//     layer's counts, the pupils' answers and the limitations — and no
//     string, in either language, calls anything a score, an accuracy or a
//     winner
//   - every key the page uses exists in both languages, with the en and fr
//     key sets for readiness and report identical
//
//   node scripts/check-pilot-ui.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL ${label}`); if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n")); };
const check = (label, actual, expected) => { const a = JSON.stringify(actual), e = JSON.stringify(expected); a === e ? ok(label) : bad(label, `got ${a}, expected ${e}`); };
const get = (obj, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
const flatten = (o, p = "") => Object.entries(o ?? {}).flatMap(([k, v]) => (v && typeof v === "object" ? flatten(v, `${p}${k}.`) : [[`${p}${k}`, String(v)]]));

const service = read("src/services/insights.service.ts");
const page    = read("src/pages/insights/intelligence-review.tsx");
const en      = JSON.parse(read("src/i18n/locales/en.json"));
const fr      = JSON.parse(read("src/i18n/locales/fr.json"));

const between = (src, from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a + 1); return a >= 0 && b > a ? src.slice(a, b) : ""; };
const panel     = between(page, "function PilotPanel(", "function Readiness(");
const readiness = between(page, "function Readiness(", "function EvidenceGrid(");
const report    = between(page, "function PilotReport(", "/** One button: the pupil through both paths");

console.log("--- the service ---");
check("the report route, the eleven engine keys, the four attestations, and an amendment that cannot omit its reason", [
  /export async function fetchPilotReport\([\s\S]{0,200}?api\.get\(`\/insights\/pilot\/\$\{pilotId\}\/report`, sp\(schoolId\)\)/.test(service),
  /export const ENGINE_KEYS = \["academic", "strengths", "exploration", "learningEvidence", "learningIntegration", "development", "guidance", "intervention", "developmentPlanning", "adaptiveSupport", "advancedIntelligence"\] as const/.test(service),
  /export const ATTESTATION_KEYS = \["schoolParticipates", "reviewersUnderstandTask", "noticeRequirementsMet", "retentionAgreed"\] as const/.test(service),
  /export async function updateFinding\([^)]*input: \{[^}]*reason: string \}/.test(service),
  /export type ReadinessStatus = "READY" \| "BLOCKED" \| "REQUIRES_CONFIRMATION"/.test(service),
], [true, true, true, true, true]);
check("no forbidden field in the pilot contract: no score, no accuracy, no rank", /accuracy|Score\b|ranking|winner|careerFit|riskScore/i.test(between(service, "export interface PilotReport", "const sp = ").replace(/noRanking: true/g, "")), false);

console.log("--- the readiness screen ---");
check("five groups, each with its status badge from the server, and the three statuses mapped", [
  /const groups = \["technical", "operational", "evidence", "reviewer", "privacy"\] as const/.test(readiness),
  /pre\.readiness\[g\]\.status/.test(readiness),
  /READY: "success", BLOCKED: "danger", REQUIRES_CONFIRMATION: "warning"/.test(page),
], [true, true, true]);
check("a manual check is a confirmation the person signs; the privacy ones say the application cannot determine them", [
  /c\.kind === "manual" \? \(\s*<Checkbox/.test(readiness),
  /intelReview\.readiness\.confirmNote/.test(readiness),
], [true, true]);
check("the page never says ready while the server does not: the blocked line is the server's missing list, and the open button waits for ready AND all four confirmations", [
  /pre\.ready \? t\("intelReview\.readiness\.awaiting"\) : t\("intelReview\.readiness\.blocked", \{ missing: pre\.missing\.join\(", "\) \}\)/.test(readiness),
  /const allAttested = ATTESTATION_KEYS\.every\(\(k\) => attest\[k\]\)/.test(panel),
  /disabled=\{create\.isPending \|\| \(kind === "real" && \(!preflightQ\.data\?\.ready \|\| !allAttested\)\)\}/.test(panel),
  /kind === "real" \? \{ attestations: attest \}/.test(panel),
], [true, true, true, true]);
check("the eleven engine versions are shown, drift is named, and CALIBRATED is not offered while an engine drifted", [
  /ENGINE_KEYS\.map\(\(k\) => `\$\{t\(`intelReview\.pilot\.engineName\.\$\{k\}`\)\} \$\{v\[k\]\}`\)/.test(panel),
  /pilot\.engineDrift\.length > 0 && \(/.test(panel),
  /\(to === "CALIBRATED" && pilot\.engineDrift\.length > 0\)/.test(panel),
], [true, true, true]);
check("a finding is amended only with a reason of a few words, carries where the disagreement comes from, and its trail is shown", [
  /disabled=\{amendFinding\.isPending \|\| amendOf\(f\)\.reason\.trim\(\)\.length < 5\}/.test(panel),
  /updateFinding\(pilot!\.pilotRunId, p\.findingId, \{[\s\S]{0,200}?reason: p\.reason \}\)/.test(panel),
  /intelReview\.finding\.source\.\$\{/.test(panel),
  /f\.amendments\?\.length > 0/.test(panel) && /intelReview\.finding\.afterClosure/.test(panel),
  /"ADVANCED_INTELLIGENCE"\] as FindingCategory\[\]/.test(panel),
], [true, true, true, true, true]);
check("the explanation layer inside the pilot is shown as counts and nothing else", /\["requests", "modelValidated", "validatorRejections", "providerFailures", "refused"\] as const/.test(panel), true);

console.log("--- the report ---");
check("scope, coverage, outcomes, the four concerns, the explanation layer, the pupils' answers, findings, limitations and what is never claimed", [
  "intelReview.report.scope", "intelReview.report.coverage", "intelReview.report.outcomes", "intelReview.report.concerns", "intelReview.report.advanced",
  "intelReview.report.feedback", "intelReview.report.findings", "intelReview.report.limitations", "intelReview.report.notClaimed", "intelReview.report.adv.validatorNote", "intelReview.concern.note",
].filter((k) => !report.includes(k)), []);
check("outcomes and concerns are rendered from the server's keys, never computed or ranked here", [
  /Object\.keys\(report\.reviewOutcomes\)/.test(report), /Object\.keys\(report\.concerns\)/.test(report),
  /sort\(|toSorted\(|Math\.max|\/ report\./.test(report),
], [true, true, false]);
check("the pupils' answers are counts per question; the breakdown is withheld when the server withholds it", [/fb\.withheld && fb\.responses > 0/.test(report), /fb\.byQuestion && \(/.test(report), /studentId|studentName/.test(report)], [true, true, false]);

console.log("--- the strings ---");
const used = [...new Set([...page.matchAll(/t\(\s*["'`](intelReview\.(?:readiness|report|preflight|finding|pilot)\.[\w.]+)["'`]/g)].map((m) => m[1]))];
check("every literal intelReview.* key the page uses exists in en and fr", used.filter((k) => get(en, k) === undefined || get(fr, k) === undefined), []);
const ENGINE_KEYS = ["academic", "strengths", "exploration", "learningEvidence", "learningIntegration", "development", "guidance", "intervention", "developmentPlanning", "adaptiveSupport", "advancedIntelligence"];
const need = [
  ...["technical", "operational", "evidence", "reviewer", "privacy"].map((g) => `intelReview.readiness.group.${g}`),
  ...["READY", "BLOCKED", "REQUIRES_CONFIRMATION"].map((s) => `intelReview.readiness.status.${s}`),
  ...ENGINE_KEYS.map((k) => `intelReview.pilot.engineName.${k}`),
  ...["schoolAuthorized", "schoolAdminPresent", "schoolParticipates", "publishedEvidence", "reviewableCases", "multiReviewCapableCases", "reviewersAvailable", "reviewersUnderstandTask", "engineInputNameFree", "consistencyOperational", "saltNotExposed", "teacherScopeEnforced", "schoolAdminScopeEnforced", "operatorSelectionRequired", "rawExportNotExposed", "studentDataBoundaries", "reviewerPrivacy", "dataMinimization", "closureBehaviour", "noticeRequirementsMet", "retentionAgreed"].map((k) => `intelReview.preflight.check.${k}`),
  ...["SUPPORTED", "PARTLY_SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT_EVIDENCE", "UNCERTAIN"].map((k) => `intelReview.report.outcome.${k}`),
  ...["INTERPRETATION_DISAGREEMENT", "DATA_QUALITY", "MISSING_EVIDENCE", "CONTEXTUAL_LIMITATION"].map((k) => `intelReview.report.concern.${k}`),
  ...["observedClear", "inferredClear", "uncertaintyClear", "evidenceClear", "explorationClear", "choiceClear"].map((k) => `intelReview.report.fb.q.${k}`),
  ...["YES", "PARTLY", "NO", "NOT_SHOWN"].map((k) => `intelReview.report.fb.a.${k}`),
  ...["undetermined", "data_quality", "missing_context", "insufficient_evidence", "interpretation_ambiguity", "rule_weakness"].map((k) => `intelReview.finding.source.${k}`),
  ...["GRADE_IMPROVEMENT", "STUDENT_OUTCOMES", "CAREER_PREDICTION", "RETENTION", "GRADUATION", "WELLBEING", "INTERVENTION_CAUSALITY", "PSYCHOLOGICAL_ASSESSMENT", "UNIVERSAL_VALIDITY"].map((k) => `intelReview.report.claim.${k}`),
  ...["INTERPRETATION_SUPPORT", "CONCERN_CATEGORIES", "DATA_QUALITY_CITATIONS", "REVIEWER_INDEPENDENCE", "EVIDENCE_WINDOW", "ENGINE_VERSION_BOUNDARY", "LIVE_OFFLINE_CONSISTENCY", "EXPLANATION_LAYER_BEHAVIOUR", "STUDENT_UNDERSTANDING", "EDUCATIONAL_EFFECTIVENESS", "CAREER_PREDICTION", "PSYCHOLOGICAL_ASSESSMENT", "INTERVENTION_CAUSALITY", "CROSS_SCHOOL_VALIDITY", "LONG_TERM_OUTCOMES", "CURRENT_RULES_FOR_THIS_SCOPE", "RULE_CHANGE_CANDIDATE_FOR_SEPARATE_PROCESS", "NO_CALIBRATION_CONCLUSION", "NO_DECISION_YET", "GENERALISATION_BEYOND_SCOPE", "TEACHER_JUDGEMENT_AS_GROUND_TRUTH", "EFFECT_ON_ANY_OUTCOME"].map((k) => `intelReview.report.lim.${k}`),
  "intelReview.finding.category.ADVANCED_INTELLIGENCE", "intelReview.pilot.error.AMENDMENT_REASON_REQUIRED", "intelReview.pilot.error.ENGINE_VERSION_CHANGED", "intelReview.pilot.error.NOTHING_TO_AMEND",
];
check("every group, status, engine, check, outcome, concern, question, word, source, claim, limitation and error the server can send has a label in both languages", need.filter((k) => typeof get(en, k) !== "string" || typeof get(fr, k) !== "string"), []);
const strings = [...flatten(en.intelReview.readiness, "readiness."), ...flatten(fr.intelReview.readiness, "readiness."), ...flatten(en.intelReview.report, "report."), ...flatten(fr.intelReview.report, "report.")];
check("no readiness or report string, in either language, calls anything accurate, a score, a rank or a winner, or says a pilot is ready while something is missing", [
  // A denial is not a claim: "no ranking of reviewers" and "aucun classement des relecteurs" are what the page must say.
  strings.filter(([, v]) => /\b(accurate|score|winner|best reviewer|best teacher|best school|top reviewer|meilleur relecteur|meilleur enseignant|classement des|pourcentage d'exactitude:)/i.test(v.replace(/\b(no|aucun|aucune) (ranking|classement|accuracy|pourcentage)[^;.]*/gi, ""))).map(([k]) => k),
  /Missing/.test(get(en, "intelReview.readiness.blocked")) && /BLOCKED/.test(get(en, "intelReview.readiness.blocked")) && /BLOQUÉ/.test(get(fr, "intelReview.readiness.blocked")),
  /not a school ready to pilot/.test(get(en, "intelReview.readiness.note")),
], [[], true, true]);
check("the attestation error and the ready line now count four, not two", [/four/.test(get(en, "intelReview.pilot.error.ATTESTATION_REQUIRED")) && /quatre/.test(get(fr, "intelReview.pilot.error.ATTESTATION_REQUIRED")), /two|deux/i.test(get(en, "intelReview.preflight.ready") + get(fr, "intelReview.preflight.ready"))], [true, false]);
check("en and fr key sets for readiness and report are identical", [["readiness", "report"].every((ns) => flatten(en.intelReview[ns]).map(([k]) => k).sort().join("|") === flatten(fr.intelReview[ns]).map(([k]) => k).sort().join("|"))], [true]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
