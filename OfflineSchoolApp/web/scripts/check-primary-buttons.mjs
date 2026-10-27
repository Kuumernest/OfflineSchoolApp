// web/scripts/check-primary-buttons.mjs
//
// C7 — one primary button colour. A filled button (white label on a solid
// colour) is the theme's `primary-*`, as components/ui/Button.tsx's primary
// variant is. Hand-made <button>/<Link>/<a> tags in indigo, blue, purple or
// violet were the drift. Green stays allowed: it is the `success` colour for
// approve and publish, not a second primary.
//
//   node scripts/check-primary-buttons.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFF = /(?<![:\w-])bg-(indigo|blue|purple|violet)-(500|600|700)\b/;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** Each opening <button|Link|a …> tag, skipping `>` inside {…} (arrow functions). */
function* tags(s) {
  const re = /<(button|Link|a)\b/g;
  let m;
  while ((m = re.exec(s))) {
    let i = re.lastIndex, depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    yield { at: m.index, text: s.slice(m.index, i + 1) };
  }
}

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) files.push(p);
  }
};
walk(path.join(ROOT, "src"));

const offenders = [];
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  for (const { at, text } of tags(s)) {
    if (text.includes("text-white") && OFF.test(text)) {
      offenders.push(`${path.relative(ROOT, f)}:${s.slice(0, at).split("\n").length}`);
    }
  }
}
check("no filled button in indigo / blue / purple / violet — primary-* only", offenders, []);
check("the Button primary variant is primary-600",
  /primary:\s*\n?\s*"bg-primary-600 text-white/.test(fs.readFileSync(path.join(ROOT, "src/components/ui/Button.tsx"), "utf8")), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
