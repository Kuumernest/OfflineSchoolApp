// web/scripts/check-normalisers.mjs
//
// Every field a normalised type declares must actually be assigned by the
// normaliser that builds it.
//
// The Class type declared classTeacherId and classTeacherName, with a comment
// explaining that a report card prints whoever held the class when it was
// issued. normaliseClass never filled either of them. Because both are
// optional, tsc had nothing to say — the returned object satisfied the type
// perfectly well without them.
//
// What followed was not a blank field. The Edit Class dialog reset the select
// to "" every time it opened, so a class with a form master read "No teacher
// assigned"; and the form submitted that "" straight back, which the server
// reads — correctly — as "clear it". Opening the dialog to rename a class and
// pressing Save unassigned its teacher, with nothing on screen to say so.
//
// An optional field that is never populated is indistinguishable from one the
// server never sent, which is why this has to be checked rather than typed.
//
//   node scripts/check-normalisers.mjs
//
// A field that a normaliser genuinely should not carry belongs in OMITTED
// below, with the reason. The list is a ratchet: it may shrink freely, and it
// grows only when somebody writes down why.

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

/** Normaliser → the interface it must satisfy. */
const PAIRS = [
  {
    fn:        "normaliseClass",
    service:   "src/services/class.service.ts",
    iface:     "Class",
    types:     "src/types/classes.types.ts",
  },
  {
    fn:        "normaliseSubject",
    service:   "src/services/class.service.ts",
    iface:     "Subject",
    types:     "src/types/classes.types.ts",
  },
];

/** Fields a normaliser is allowed not to assign, and why. */
const OMITTED = {
  // Empty, and it should stay that way. The first two entries written here
  // named fields the interface did not declare at all, and the staleness check
  // below caught them immediately — which is the point of writing the reason
  // down rather than just silencing the field.
};

/** The body of `function name(...) { ... }`, by brace depth. */
const bodyOf = (src, name) => {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
};

/** The body of `interface Name { ... }`. */
const interfaceOf = (src, name) => {
  const at = src.search(new RegExp(`(export\\s+)?interface\\s+${name}\\s*(extends[^{]+)?\\{`));
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
};

/** Comments out, so a field named only in prose does not count as declared. */
const decomment = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

console.log("");
console.log("NORMALISERS FILL THE TYPES THEY CLAIM TO BUILD");

for (const { fn, service, iface, types } of PAIRS) {
  const serviceSrc = fs.readFileSync(path.join(ROOT, service), "utf8");
  const typesSrc   = fs.readFileSync(path.join(ROOT, types),   "utf8");

  const body = bodyOf(serviceSrc, fn);
  const decl = interfaceOf(typesSrc, iface);

  if (!body) { bad(`${fn} can be read`); continue; }
  if (!decl) { bad(`the ${iface} interface can be read`); continue; }

  // Declared fields: `name?: T;` / `name: T;` at the top level of the block.
  const declared = [...decomment(decl).matchAll(/^\s{0,4}(\w+)\??\s*:/gm)].map((m) => m[1]);
  if (!declared.length) { bad(`the ${iface} interface declares fields`); continue; }

  // Assigned keys: `name:` or the shorthand `name,` in the returned literal.
  const assigned = new Set([
    ...[...decomment(body).matchAll(/^\s+(\w+)\s*:/gm)].map((m) => m[1]),
    ...[...decomment(body).matchAll(/^\s+(\w+),\s*$/gm)].map((m) => m[1]),
  ]);

  const allowed = OMITTED[fn] ?? {};
  const missing = declared.filter((f) => !assigned.has(f) && !(f in allowed));

  if (missing.length) {
    bad(
      `${fn} fills every field ${iface} declares`,
      missing.map((f) => `${f} is declared on ${iface} and never assigned`).join("\n")
    );
  } else {
    const note = Object.keys(allowed).length
      ? ` (${Object.keys(allowed).length} deliberately omitted)`
      : "";
    ok(`${fn} fills every field ${iface} declares (${declared.length} checked)${note}`);
  }

  // A stale allowance is worth knowing about: it means somebody fixed the
  // omission and left the excuse behind.
  const stale = Object.keys(allowed).filter((f) => assigned.has(f) || !declared.includes(f));
  if (stale.length) {
    bad(
      `every OMITTED entry for ${fn} is still needed`,
      stale.map((f) => `${f} is allowed to be missing but is assigned, or no longer declared`).join("\n")
    );
  }
}

// ── The specific field this was written for ─────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, "src/services/class.service.ts"), "utf8");
  const body = decomment(bodyOf(src, "normaliseClass") ?? "");
  if (/classTeacherId\s*:/.test(body) && /classTeacherName\s*:/.test(body)) {
    ok("a class carries its form master's id and name through the normaliser");
  } else {
    bad("a class carries its form master through the normaliser",
        "the Edit Class dialog cannot show a teacher the normaliser dropped, " +
        "and saving the dialog then clears the assignment");
  }
}

// ── And the dialog must not lose a teacher who has left ─────────────────────
{
  const page = fs.readFileSync(path.join(ROOT, "src/pages/classes/ClassesPage.tsx"), "utf8");
  if (/editingClass\?\.classTeacherId/.test(page) && /teacherOptions\.splice/.test(page)) {
    ok("the class dialog keeps an option for a form master who is no longer listed");
  } else {
    bad("the class dialog keeps an option for an unlisted form master",
        "a deactivated teacher is absent from /admin/teachers; a select given a " +
        "value no option carries falls back to the first one, and Save writes it");
  }
}

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
