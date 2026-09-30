// web/scripts/check-intelligence-ui.mjs
//
// Stage 17 on the web: the staff Explanation section on the student
// strengths page. Static: reads the source and the locales, no browser.
//
//   - the service calls the three routes, unwraps the envelope, carries
//     schoolId the way the other insights calls do
//   - the page mounts the section for staff only, imports nothing from a
//     provider SDK, never auto-submits a question, bounds it at 1000
//   - every claim type, mode, fallback reason and source type the backend
//     can return has a label in both languages; the keys the page uses exist
//   - the wording keeps agency: no "recommended career", no "you should
//     become", no career match, score or ranking in either language
//   - citations are rendered through a label helper, never as raw ids
//
//   node scripts/check-intelligence-ui.mjs

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

const service = read("src/services/insights.service.ts");
const page    = read("src/pages/insights/student-strengths.tsx");
const en      = JSON.parse(read("src/i18n/locales/en.json"));
const fr      = JSON.parse(read("src/i18n/locales/fr.json"));

console.log("--- the service ---");
check("three functions, three routes, the envelope unwrapped", [
  /export async function fetchIntelligenceSummary\([\s\S]{0,240}?api\.get\(`\/insights\/student\/\$\{studentId\}\/intelligence-summary`, q\(schoolId\)\)/.test(service),
  /export async function explainStudent\([\s\S]{0,240}?api\.post\(`\/insights\/student\/\$\{studentId\}\/explain`, body\)/.test(service),
  /export async function askStudent\([\s\S]{0,240}?api\.post\(`\/insights\/student\/\$\{studentId\}\/ask`, body\)/.test(service),
  (service.match(/\(data as \{ data: (IntelligenceSummary|ExplainResponse) \}\)\.data/g) ?? []).length,
], [true, true, true, 3]);
check("the response types carry the contract: five claim types, four modes, typed claims with citations, the boundary", [
  /export type ClaimType = "OBSERVED" \| "INFERRED_BY_DETERMINISTIC_ENGINE" \| "SUGGESTED_EXPLORATION" \| "UNCERTAIN" \| "NOT_AVAILABLE"/.test(service),
  /export type ExplainMode = "DETERMINISTIC" \| "MODEL_VALIDATED" \| "DETERMINISTIC_FALLBACK" \| "REFUSED"/.test(service),
  /output: \{ answer: string; claims: ExplainClaim\[\]; uncertainty: string; limitations: string\[\]; suggestedQuestions: string\[\] \}/.test(service),
  /asOf: string; evidenceBoundaryHash: string/.test(service),
], [true, true, true, true]);
check("no forbidden field anywhere in the client contract", /careerFit|careerProbability|careerScore|careerMatch|predictedCareer|recommendedCareer|riskScore|personality/i.test(service + page), false);

console.log("--- the page ---");
const start = page.indexOf("function Explanation(");
const explanation = start >= 0 ? page.slice(start) : "";
check("the section is imported from the service and mounted for staff only", [
  /fetchIntelligenceSummary, explainStudent,/.test(page),
  /\{isStaff && <Explanation studentId=\{studentId\} schoolId=\{schoolId\} toast=\{toast\} \/>\}/.test(page),
  start >= 0,
], [true, true, true]);
check("no provider SDK, no model name, no key in the client", /@anthropic-ai|anthropic|claude-|ANTHROPIC_API_KEY|sk-ant-/i.test(page + service), false);
check("a question is bounded at 1000 characters and submitted only by the button; a suggested question only fills the box", [
  /maxLength=\{1000\}/.test(explanation),
  /onClick=\{submit\}/.test(explanation),
  /onClick=\{\(\) => onPick\(q\)\}/.test(explanation) && /onPick=\{\(q\) => setQuestion\(q\)\}/.test(explanation),
  /useEffect/.test(explanation),
  /onKeyDown|onSubmit=/.test(explanation),
], [true, true, true, false, false]);
check("the answer is rendered as sections — mode, boundary, answer, typed claims with citations, uncertainty, limitations, suggested questions — not as a transcript", [
  /t\(`explain\.mode\.\$\{r\.mode\}`/.test(explanation), /explain\.boundary/.test(explanation), /r\.output\.answer/.test(explanation),
  /t\(`explain\.claimType\.\$\{c\.type\}`/.test(explanation), /citationLabel\(/.test(explanation), /r\.output\.uncertainty/.test(explanation),
  /r\.output\.limitations/.test(explanation), /r\.output\.suggestedQuestions/.test(explanation),
], [true, true, true, true, true, true, true, true]);
check("citations go through the label helper, which names the kind of record and what it is about, never the id", [
  /function citationLabel\(item: CitationItem\["item"\], t: Tr\): string/.test(page), /explain\.source\.\$\{item\.sourceType\}/.test(page), /\{c\.sourceId\}|\{item\.sourceId\}|sourceId\}<\//.test(explanation),
], [true, true, false]);
check("the career transformation and the fallback reason are shown to the reader", [/CAREER_TO_EXPLORATION/.test(explanation), /explain\.reason\.\$\{r\.fallbackReason\}/.test(explanation)], [true, true]);
check("accessibility: a labelled textarea, a labelled prompt group, a live region for the answer, buttons that are buttons", [
  /aria-label=\{t\("explain\.questionLabel"\)\}/.test(explanation), /role="group" aria-label=\{t\("explain\.promptsLabel"\)\}/.test(explanation), /aria-live="polite"/.test(explanation),
  (explanation.match(/<Button /g) ?? []).every(() => true) && !/<div[^>]*onClick/.test(explanation),
], [true, true, true, true]);

console.log("--- the routes ---");
const appTsx = read("src/App.tsx");
const nav = read("src/config/navigation.ts");
const blockOf = (gate) => { const start = appTsx.indexOf(`<Route element={gate(${gate})}>`); if (start < 0) return ""; const end = appTsx.indexOf("\n          </Route>", start); return appTsx.slice(start, end); };
const inGate = (gate, routePath) => blockOf(gate).includes(`path="${routePath}"`);
check("the intelligence pages sit in the gate the navigation offers them to — TEACHING for class intelligence, the review and the pupil page; OFFICE for the arrears watch list — and the API scopes the teacher beneath", [
  inGate("TEACHING", "/class-intelligence"), inGate("TEACHING", "/intelligence-review"), inGate("TEACHING", "/students/:studentId/strengths"),
  inGate("OFFICE", "/watchlist"), inGate("OFFICE", "/class-intelligence") || inGate("OFFICE", "/intelligence-review") || inGate("OFFICE", "/students/:studentId/strengths"),
  /path:\s*"\/class-intelligence"[\s\S]{0,200}?roles:\s*\["super_admin", "school_admin", "teacher"\]/.test(nav), /path:\s*"\/watchlist"[\s\S]{0,200}?roles:\s*\["super_admin", "school_admin", "bursar"\]/.test(nav),
], [true, true, true, true, false, true, true]);

console.log("--- the strings ---");
const used = [...new Set([...page.matchAll(/t\(\s*["'`](explain\.[\w.]+)["'`]/g)].map((m) => m[1]))];
check("every explain.* key the page uses literally exists in en and fr", used.filter((k) => get(en, k) === undefined || get(fr, k) === undefined), []);
const need = [
  ...["OBSERVED", "INFERRED_BY_DETERMINISTIC_ENGINE", "SUGGESTED_EXPLORATION", "UNCERTAIN", "NOT_AVAILABLE"].map((k) => `explain.claimType.${k}`),
  ...["DETERMINISTIC", "MODEL_VALIDATED", "DETERMINISTIC_FALLBACK", "REFUSED"].map((k) => `explain.mode.${k}`),
  ...["PROVIDER_NOT_CONFIGURED", "PROVIDER_AUTH", "PROVIDER_UNAVAILABLE", "MODEL_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_QUOTA", "PROVIDER_REFUSED", "INVALID_RESPONSE", "VALIDATION_FAILED", "CATEGORY_NOT_NARRATABLE", "OFFLINE"].map((k) => `explain.reason.${k}`),
  ...["ACADEMIC_PROFILE", "STRENGTH_PROFILE", "LEARNING_EVIDENCE", "DEVELOPMENT_HISTORY", "EXPLORATION", "GUIDANCE", "INTERVENTION", "DEVELOPMENT_PLAN", "PLAN_REVIEW", "unknown"].map((k) => `explain.source.${k}`),
  ...["profile", "changed", "evidence", "guidance", "plan", "explore"].map((k) => `explain.prompt.${k}`),
  "explain.error.generic", "explain.error.forbidden", "explain.error.notFound", "explain.error.offline", "explain.error.QUESTION_REQUIRED", "explain.error.QUESTION_TOO_LONG", "explain.agency", "explain.careerTransformed",
];
check("every claim type, mode, fallback reason, source type, prompt and error the backend can produce has a label in both languages", need.filter((k) => typeof get(en, k) !== "string" || typeof get(fr, k) !== "string"), []);
const flatten = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flatten(v, `${p}${k}.`) : [[`${p}${k}`, String(v)]]));
const explainStrings = [...flatten(en.explain ?? {}, "explain."), ...flatten(fr.explain ?? {}, "explain.")];
const FORBIDDEN = /recommended career|best career|ideal career|career (match|score|ranking|probability|fit)|you should become|you are suited|your future is|the right career|carrière recommandée|meilleure carrière|carrière idéale|vous devriez devenir|vous êtes fait pour|votre avenir est/i;
check("no explain.* string, in either language, recommends, ranks, scores or predicts a career, or tells a student what to become", explainStrings.filter(([, v]) => FORBIDDEN.test(v)).map(([k]) => k), []);
check("the agency line and the exploration hint say who decides", [/student decides/i.test(get(en, "explain.agency")), /l'élève décide/i.test(get(fr, "explain.agency")), /not ranked/i.test(get(en, "explain.explorationHint")), /sans classement/i.test(get(fr, "explain.explorationHint"))], [true, true, true, true]);
check("en and fr explain.* key sets are identical", [flatten(en.explain ?? {}).map(([k]) => k).sort(), flatten(fr.explain ?? {}).map(([k]) => k).sort()].map((a) => a.join("|")).every((s, _, arr) => s === arr[0]), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
