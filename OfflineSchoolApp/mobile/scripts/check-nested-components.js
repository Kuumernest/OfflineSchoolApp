// mobile/scripts/check-nested-components.js
"use strict";

/**
 * No screen defines a component inside itself and renders it as a tag.
 *
 * The homework form declared `const Field = (...) => (...)` inside the
 * screen and wrapped every TextInput in <Field>. Each keystroke set state,
 * the screen re-ran, Field became a new function — a new component type to
 * React — so React unmounted the old subtree and mounted a fresh TextInput.
 * The keyboard closed after one character. Nothing failed: the code parsed,
 * linted and rendered, and only a finger on a phone could tell.
 *
 * So this looks for an indented (nested) `const Name = (...) =>` /
 * `function Name(` whose Name is then used as <Name ...>. Hoist it to
 * module scope, or call it as {renderName()} if it needs the screen's state.
 *
 *   node scripts/check-nested-components.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : /\.jsx?$/.test(e.name) ? [full] : [];
});

console.log("--- components defined inside other components ---");
const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "src"))];
const found = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const src = lines.join("\n");
  lines.forEach((line, i) => {
    const m = line.match(/^\s+(?:const\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\(|[a-z_]\w*\s*=>|function\b)|function\s+([A-Z][A-Za-z0-9]*)\s*\()/);
    const name = m && (m[1] || m[2]);
    if (name && new RegExp(`<${name}[\\s/>]`).test(src)) {
      found.push(`${path.relative(ROOT, file)}:${i + 1}  ${name}`);
    }
  });
}
if (found.length === 0) ok(`none in ${files.length} files`);
else bad("a component is defined inside another and rendered as a tag (it remounts every render)", found.join("\n"));

const hw = fs.readFileSync(path.join(ROOT, "app", "teacher", "homework", "create.js"), "utf8");
if (/^const Field = /m.test(hw)) ok("the homework form's Field lives at module scope");
else bad("the homework form's Field is no longer at module scope");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
