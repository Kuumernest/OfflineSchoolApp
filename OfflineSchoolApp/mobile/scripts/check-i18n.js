// mobile/scripts/check-i18n.js
"use strict";

/**
 * The placeholders i18n-js prints into the running app.
 *
 * ── What a user actually saw ──────────────────────────────────────────────
 *
 * On the teacher's register, across the top, in front of whoever was taking
 * it:
 *
 *   [missing "en.attAdmin.allPeriods" translation]
 *   0 [missing "en." translation]   0 [missing "en." translation]   …
 *
 * i18n-js does not throw on a missing key and does not fall back to the key
 * name — it renders that sentence, at whatever width it happens to be, into
 * the layout. So the failure is never a crash, never a log line, and never
 * visible to anybody who is not looking at that screen in that language.
 *
 * The web has had scripts/check-i18n.mjs for exactly this. The phone did not,
 * which is why four of these reached a register.
 *
 * ── The four rules, and why each one exists ───────────────────────────────
 *
 *   1. KEY PARITY. A key in en.json with nothing in fr.json. enableFallback
 *      is on, so a francophone reads one English word in a French screen and
 *      files it as a bug rather than as a missing translation.
 *
 *   2. UNRESOLVED LITERAL. t("attAdmin.allPeriods") where no such key exists.
 *      This is the first line of the screenshot.
 *
 *   3. A STRING AS THE SECOND ARGUMENT. t("attAdmin.allPeriods", "All").
 *      This reads like a fallback and is not one: i18n-js takes an options
 *      OBJECT there, so the string is ignored and the placeholder prints
 *      anyway. Ten call sites had one, and every one of them was somebody
 *      believing they had written a safety net. A rule that only checked
 *      whether keys resolve would pass all ten and leave the habit in place.
 *
 *   4. A KEY THE MAPPED OBJECTS NEVER DEFINE. t(s.labelKey) over objects that
 *      carry `label:`. t(undefined) is the second line of the screenshot —
 *      four chips, each reading [missing "en." translation].
 *
 *      A computed key cannot be resolved statically in general, but
 *      `[ {…}, {…} ].map(s => t(s.prop))` can: the array is right there in the
 *      expression and nothing else can widen `s`. See the note above the rule
 *      for why this one is parsed rather than pattern-matched — the pattern
 *      version passed on the very file the screenshot came from, and it found
 *      a third instance of the defect the moment it could actually see.
 *
 * Run: npm run check:i18n
 */

const fs   = require("fs");
const path = require("path");

const ROOT       = path.join(__dirname, "..");
const LOCALE_DIR = path.join(ROOT, "src", "i18n", "locales");
const BASE       = "en";

// ── Locales ───────────────────────────────────────────────────────────────

const load = (lang) =>
  JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${lang}.json`), "utf8"));

/*
 * A plural entry is a LEAF, not a namespace.
 *
 *   "classCount": { "one": "%{count} class", "other": "%{count} classes" }
 *
 * is addressed in source as t("examNew.classCount", { count }) — i18n-js picks
 * the branch itself. Descending into it would register classCount.one and
 * classCount.other and leave the key the code actually uses looking absent, so
 * the first run of this check reported 83 of these as missing. Eighty-three
 * false positives is not a noisy check, it is a check nobody will run twice.
 */
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

const isPluralEntry = (v) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => PLURAL_CATEGORIES.has(k));

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPluralEntry(v)) return [key];
    return v && typeof v === "object" && !Array.isArray(v) ? flatten(v, key) : [key];
  });

const languages = fs.readdirSync(LOCALE_DIR)
  .filter((f) => path.extname(f) === ".json")
  .map((f) => f.replace(/\.json$/, ""));

const keysByLang = Object.fromEntries(
  languages.map((lang) => [lang, new Set(flatten(load(lang)))])
);

// ── Sources ───────────────────────────────────────────────────────────────

const sourceFiles = [];
for (const dir of ["app", "src"]) {
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".") || name === "locales") continue;
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if ([".js", ".jsx", ".ts", ".tsx"].includes(path.extname(name))) sourceFiles.push(full);
    }
  })(path.join(ROOT, dir));
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// A literal key: t("a.b") and labelKey: "a.b". A key with no dot is almost
// always something else being passed to a function called t, so a dot is
// required — the locale files are namespaced throughout.
const LITERAL = /(?:\bt\(\s*|labelKey:\s*)["'`]([A-Za-z][\w.]*\.[\w.]+)["'`]/g;

// t("key", "a string"). The options argument of i18n-js is an object.
const STRING_SECOND_ARG = /\bt\(\s*["'`][\w.]+["'`]\s*,\s*["'][^"']*["']\s*[),]/g;

/*
 * ── Rule 4 needs a parser, not a pattern ──────────────────────────────────
 *
 * The first version of this rule asked whether a file mentioned `labelKey:`
 * anywhere. mark.js does — STATUS_OPTIONS at the top of the file carries four
 * of them — so the rule skipped the very defect it was written for and
 * reported the file clean. A check that passes on the bug in the screenshot
 * is worse than no check, because it is also an assurance.
 *
 * What actually shipped was local and precise:
 *
 *   [ { label: "P", value: presentCount }, … ].map((s) => … t(s.labelKey) …)
 *
 * The array is RIGHT THERE. Its objects define `label`, the body reads
 * `labelKey`, and nothing else can widen `s` — so the answer is decidable
 * without leaving the expression. That is an AST question, and @babel/parser
 * is already a dependency of the toolchain this app is built with.
 */
const { parse } = require("@babel/parser");
const traverse  = require("@babel/traverse").default;

/**
 * t(param.prop) inside `[…object literals…].map(param => …)`, where the
 * objects never define `prop`. Returns [{ line, prop, defined }].
 */
const mapCallbackKeyMismatches = (ast) => {
  const found = [];

  traverse(ast, {
    CallExpression(pathNode) {
      const callee = pathNode.node.callee;
      if (callee.type !== "MemberExpression") return;
      if (callee.property.name !== "map") return;
      if (callee.object.type !== "ArrayExpression") return;

      // Every property name any element of the array literal defines.
      const defined = new Set();
      let allPlainObjects = true;
      for (const el of callee.object.elements) {
        if (!el || el.type !== "ObjectExpression") { allPlainObjects = false; break; }
        for (const prop of el.properties) {
          if (prop.type === "ObjectProperty" && !prop.computed && prop.key.name) {
            defined.add(prop.key.name);
          } else {
            // A spread or a computed key could contribute anything.
            allPlainObjects = false;
          }
        }
      }
      if (!allPlainObjects || defined.size === 0) return;

      const cb = pathNode.node.arguments[0];
      if (!cb || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) return;
      const param = cb.params[0];
      if (!param || param.type !== "Identifier") return;

      pathNode.get("arguments.0").traverse({
        CallExpression(inner) {
          if (inner.node.callee.type !== "Identifier" || inner.node.callee.name !== "t") return;
          const arg = inner.node.arguments[0];
          if (!arg || arg.type !== "MemberExpression" || arg.computed) return;
          if (arg.object.type !== "Identifier" || arg.object.name !== param.name) return;
          const prop = arg.property.name;
          if (defined.has(prop)) return;
          found.push({ line: inner.node.loc.start.line, prop, defined: [...defined] });
        },
      });
    },
  });

  return found;
};

let problems = 0;
const fail = (msg) => { problems += 1; console.error(msg); };

// ── 1. Key parity ─────────────────────────────────────────────────────────

const baseKeys = keysByLang[BASE];
for (const lang of languages.filter((l) => l !== BASE)) {
  const missing = [...baseKeys].filter((k) => !keysByLang[lang].has(k));
  const extra   = [...keysByLang[lang]].filter((k) => !baseKeys.has(k));
  if (missing.length) {
    console.error(`\n  ${lang}.json is missing ${missing.length} key(s) present in ${BASE}.json:`);
    for (const k of missing) fail(`      ${k}`);
  }
  if (extra.length) {
    console.error(`\n  ${lang}.json has ${extra.length} key(s) not in ${BASE}.json:`);
    for (const k of extra) fail(`      ${k}`);
  }
}

// ── 2–4. The source rules ─────────────────────────────────────────────────

const unresolved = [], stringArg = [], neverSet = [], unparsed = [];

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, "utf8");

  for (const m of text.matchAll(LITERAL)) {
    if (!baseKeys.has(m[1])) {
      unresolved.push(`      ${rel(file)}:${lineOf(text, m.index)}  ${m[1]}`);
    }
  }

  for (const m of text.matchAll(STRING_SECOND_ARG)) {
    stringArg.push(`      ${rel(file)}:${lineOf(text, m.index)}  ${m[0].trim().slice(0, 64)}`);
  }

  /*
   * Only parse what could possibly match.
   *
   * Rule 4 needs `[…].map(x => … t(x.prop) …)`, so a file with no `.map(` or
   * no `t(<identifier>.` cannot contain it. Parsing all 204 files took 58
   * seconds; this brings it under three, which is the difference between a
   * check that runs on every commit and one that gets taken out of the chain
   * for being slow.
   */
  const couldMatch = /\.map\s*\(/.test(text) && /\bt\(\s*[A-Za-z_$][\w$]*\./.test(text);

  let ast = null;
  try {
    ast = couldMatch ? parse(text, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript", "classProperties", "objectRestSpread"],
      errorRecovery: true,
    }) : null;
  } catch {
    // A file this parser cannot read is reported rather than silently skipped:
    // a rule that quietly stops covering a file is how the gap reopens.
    unparsed.push(`      ${rel(file)}`);
  }

  if (ast) {
    for (const hit of mapCallbackKeyMismatches(ast)) {
      neverSet.push(
        `      ${rel(file)}:${hit.line}  t(….${hit.prop}) — the objects mapped over ` +
        `define ${hit.defined.map((d) => `\`${d}\``).join(", ")}, never \`${hit.prop}\``
      );
    }
  }
}

const report = (title, rows, note) => {
  if (!rows.length) return;
  console.error(`\n  ${title}: ${rows.length}`);
  if (note) console.error(`  ${note}`);
  for (const r of rows) fail(r);
};

report("keys referenced in source that do not exist in en.json", unresolved,
  "i18n-js renders these as [missing \"en.<key>\" translation], on screen.");
report("a string passed as t()'s second argument", stringArg,
  "i18n-js takes an options OBJECT there. The string is ignored, so this is\n  not the fallback it looks like — add the key instead.");
report("t() on a property the mapped objects never define", neverSet,
  "t(undefined) renders as [missing \"en.\" translation].");
report("files this check could not parse", unparsed,
  "Rule 4 did not run on these. Reported rather than skipped quietly.");

// ── Verdict ───────────────────────────────────────────────────────────────

if (problems > 0) {
  console.error(`\n  ${problems} i18n problem(s). Every one of these is a string a user can see.\n`);
  process.exit(1);
}

console.log(
  `  i18n OK — ${baseKeys.size} keys, ${languages.length} languages, ` +
  `${sourceFiles.length} source files checked`
);
