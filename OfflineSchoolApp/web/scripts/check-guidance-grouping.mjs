// web/scripts/check-guidance-grouping.mjs
//
// The class-intelligence card groups a student's guidance by subject before it
// renders. This proves the transformation itself, on fixtures shaped like the
// server's rows, without a browser:
//
//   - one subject with two distinct findings → one group naming both codes
//   - an exact repeat of one code on one subject → one code, not two
//   - two subjects → two groups, in input order
//   - a strength and a risk on one subject → both kept under that subject
//   - a general finding (no subject) stays its own group
//   - the group's priority is the highest among its findings
//   - the input is not mutated; nothing is dropped
//   - the card uses the helper; the locale carries a sentence for every code
//
//   node scripts/check-guidance-grouping.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { groupGuidanceBySubject } = await import(pathToFileURL(path.join(ROOT, "src/services/guidanceGrouping.js")).href);

const item = (subjectId, subjectName, rationaleCode, priority, type) => ({ type, priority, subjectId, subjectName, rationaleCode, confidence: "medium" });
const chemDecline = item("chem", "Chemistry", "RECENT_DECLINE", "high", "risk");
const chemChange  = item("chem", "Chemistry", "SUDDEN_PERFORMANCE_CHANGE", "moderate", "risk");
const bioDecline  = item("bio", "Biology", "RECENT_DECLINE", "moderate", "risk");
const physStrong  = item("phys", "Physics", "SUBJECT_STRENGTH", "low", "strength");
const physImprove = item("phys", "Physics", "SUSTAINED_IMPROVEMENT", "low", "strength");
const general     = item(null, null, "INSUFFICIENT_ACADEMIC_EVIDENCE", "low", "monitoring");

console.log("\n--- the transformation ---");
const input = [chemDecline, chemChange, bioDecline, physStrong, physImprove, general];
const snapshot = JSON.stringify(input);
const groups = groupGuidanceBySubject(input);

check("Chemistry's two findings become one group that names both codes, in order", [groups[0].subjectName, groups[0].rationaleCodes], ["Chemistry", ["RECENT_DECLINE", "SUDDEN_PERFORMANCE_CHANGE"]]);
check("the same subject is never named twice", groups.filter((g) => g.subjectId === "chem").length, 1);
check("Biology stays apart from Chemistry: two subjects, two groups, input order kept", groups.map((g) => g.subjectName), ["Chemistry", "Biology", "Physics", null]);
check("Physics keeps both of its strengths under one name — nothing dropped", [groups[2].rationaleCodes, groups[2].types], [["SUBJECT_STRENGTH", "SUSTAINED_IMPROVEMENT"], ["strength"]]);
check("a general finding is its own group with no subject", [groups[3].subjectId, groups[3].rationaleCodes], [null, ["INSUFFICIENT_ACADEMIC_EVIDENCE"]]);
check("a group carries the highest priority among its findings", [groups[0].priority, groups[2].priority], ["high", "low"]);
check("every original item is still reachable from its group", groups.reduce((n, g) => n + g.items.length, 0), input.length);
check("the input array and its items are not mutated", JSON.stringify(input), snapshot);

const mixed = groupGuidanceBySubject([item("chem", "Chemistry", "RECENT_DECLINE", "moderate", "risk"), item("chem", "Chemistry", "SUBJECT_STRENGTH", "low", "strength")]);
check("a risk and a strength on one subject are both kept, as two types under one name", [mixed.length, mixed[0].rationaleCodes, mixed[0].types.sort()], [1, ["RECENT_DECLINE", "SUBJECT_STRENGTH"], ["risk", "strength"]]);

const repeated = groupGuidanceBySubject([chemDecline, { ...chemDecline }, chemChange]);
check("an exact repeat of one code on one subject collapses to one code, while the other finding stays", repeated[0].rationaleCodes, ["RECENT_DECLINE", "SUDDEN_PERFORMANCE_CHANGE"]);
check("the repeat is kept in items (nothing is deleted), only not repeated in the wording", repeated[0].items.length, 3);

check("empty, null and malformed input answer with no groups and no throw", [groupGuidanceBySubject([]), groupGuidanceBySubject(null), groupGuidanceBySubject([{ priority: "high" }])], [[], [], []]);

console.log("\n--- the card and the locale ---");
const page = read("src/pages/insights/class-intelligence.tsx");
const en = JSON.parse(read("src/i18n/locales/en.json")), fr = JSON.parse(read("src/i18n/locales/fr.json"));
check("the card renders one badge per group and names the subject once before its findings", [
  /groupGuidanceBySubject\(items\)\.map\(\(g\) =>/.test(page),
  /\$\{g\.subjectName\} · \$\{g\.rationaleCodes\.map\(\(code\) => t\(`guidance\.\$\{code\}`\)\)\.join\(" "\)\}/.test(page),
  /import \{ groupGuidanceBySubject \} from "@\/services\/guidanceGrouping"/.test(page),
], [true, true, true]);
for (const code of ["RECENT_DECLINE", "SUDDEN_PERFORMANCE_CHANGE", "PERSISTENT_UNDERPERFORMANCE", "SUBJECT_STRENGTH", "SUSTAINED_IMPROVEMENT", "CONSISTENT_STRENGTH", "INSUFFICIENT_ACADEMIC_EVIDENCE"]) {
  check(`guidance.${code} has a sentence in both languages`, [typeof en.guidance?.[code], typeof fr.guidance?.[code]], ["string", "string"]);
}
check("the decline and the sudden-change sentences are different sentences, so grouping loses no information", en.guidance.RECENT_DECLINE !== en.guidance.SUDDEN_PERFORMANCE_CHANGE && fr.guidance.RECENT_DECLINE !== fr.guidance.SUDDEN_PERFORMANCE_CHANGE, true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
