// mobile/scripts/check-hardcoded-strings.js
"use strict";

/**
 * Text a user reads, written straight into a screen instead of through t().
 *
 * check-i18n.js holds the keys (both languages, every t("…") resolves); it
 * cannot see a sentence that never became a key. This walks app/ and src/
 * with the TypeScript parser and lists what a user would read in one language
 * only: JSX text, user-facing props (placeholder, title, accessibilityLabel…),
 * Alert.alert and toast arguments.
 *
 * The phone already had such strings when this was written (docs/39 §20.0,
 * detail-check pass). They are listed in hardcoded-strings.baseline.json:
 * a string in the baseline is known, not approved, and each one translated is
 * deleted from it. A string NOT in the baseline fails the check. A line that
 * must stay as it is (a brand, a format sample) says `// i18n-exempt`.
 *
 *   node scripts/check-hardcoded-strings.js            the check
 *   node scripts/check-hardcoded-strings.js --update   rewrite the baseline to what is found now
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = process.env.CHECK_ROOT || path.join(__dirname, "..");
const dirs = ["app", "src"];
const BASELINE = path.join(__dirname, "hardcoded-strings.baseline.json");
const files = [];
(function walkAll() {
  for (const d of dirs)
    (function w(p) {
      for (const n of fs.readdirSync(p)) {
        if (["node_modules", "locales", "__tests__"].includes(n) || n.startsWith(".")) continue;
        const f = path.join(p, n);
        if (fs.statSync(f).isDirectory()) w(f);
        else if (/\.(tsx?|jsx?)$/.test(n) && !/\.(test|spec)\./.test(n) && !n.endsWith(".d.ts")) files.push(f);
      }
    })(path.join(root, d));
})();
const ATTR = new Set([
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "label",
  "helperText",
  "description",
  "accessibilityLabel",
  "accessibilityHint",
  "emptyText",
  "emptyMessage",
  "message",
  "confirmText",
  "cancelText",
  "confirmLabel",
  "cancelLabel",
  "subtitle",
  "heading",
  "hint",
  "tooltip",
  "buttonText",
  "actionLabel",
  "text",
  "header",
  "caption",
  "emptyTitle",
  "emptyDescription",
  "loadingText",
  "submitLabel",
  "okText",
  "headerTitle",
  "tabBarLabel",
]);
const CALL =
  /^(alert|confirm|prompt|window\.(alert|confirm|prompt)|Alert\.alert|toast(\.\w+)?|showToast|notify(\.\w+)?|setError|setLoadError|setErr|setMessage|setFormError|setNotice|setStatus|setInfo|setWarning|Toast\.show|showMessage|showError|showSuccess)$/;
const visible = (s) => {
  const t = s.replace(/\$\{[^}]*\}/g, "").trim();
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(t)) return false;
  if (/^[a-z0-9_.\-\/:#@?=&]+$/.test(t)) return false;
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 2 && t.includes("_")) return false;
  if (/^(https?:|\/|#|\.)/.test(t)) return false;
  if (
    /^[\w-]+(\s[\w-]+)*$/.test(t) &&
    /(^|\s)(flex|text-|bg-|px-|py-|mt-|w-|h-|rounded|border|grid|items-|gap-)/.test(t)
  )
    return false;
  return true;
};
const res = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const kind = f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kind);
  const lines = src.split("\n");
  const add = (node, k, text) => {
    const ln = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (/i18n-exempt/.test(lines[ln - 1] || "") || /i18n-exempt/.test(lines[ln - 2] || "")) return;
    if (!visible(text)) return;
    res.push({ file: path.relative(root, f), line: ln, kind: k, text: text.replace(/\s+/g, " ").trim() });
  };
  const strOf = (n) => {
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.getText(sf).slice(1, -1);
    return null;
  };
  const litsIn = (n, k) => {
    // string literals in expression: conditional, ||, ??, direct
    if (!n) return;
    if (ts.isParenthesizedExpression(n)) return litsIn(n.expression, k);
    const s = strOf(n);
    if (s != null) return add(n, k, s);
    if (ts.isConditionalExpression(n)) {
      litsIn(n.whenTrue, k);
      litsIn(n.whenFalse, k);
    }
    if (
      ts.isBinaryExpression(n) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
        n.operatorToken.kind
      )
    ) {
      litsIn(n.right, k);
      if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) litsIn(n.left, k);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      litsIn(n.left, k);
      litsIn(n.right, k);
    }
  };
  (function v(n) {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf);
      if (t.trim()) add(n, "jsx-text", t);
    } else if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      litsIn(n.expression, "jsx-expr");
    } else if (ts.isJsxAttribute(n)) {
      const nm = n.name.getText(sf);
      if (ATTR.has(nm)) {
        const i = n.initializer;
        if (i) {
          if (ts.isStringLiteral(i)) add(i, "attr:" + nm, i.text);
          else if (ts.isJsxExpression(i)) litsIn(i.expression, "attr:" + nm);
        }
      }
    } else if (ts.isCallExpression(n)) {
      const c = n.expression.getText(sf);
      if (CALL.test(c)) {
        for (const a of n.arguments) {
          litsIn(a, "call:" + c);
          if (ts.isObjectLiteralExpression(a))
            for (const p of a.properties)
              if (
                ts.isPropertyAssignment(p) &&
                ["title", "description", "message", "text", "text1", "text2"].includes(p.name.getText(sf))
              )
                litsIn(p.initializer, "call:" + c + "." + p.name.getText(sf));
        }
      }
    } else if (
      ts.isPropertyAssignment(n) &&
      ["title", "headerTitle", "tabBarLabel", "placeholder"].includes(n.name.getText?.(sf)) &&
      n.parent &&
      n.parent.parent &&
      ts.isCallExpression(n.parent.parent) === false
    ) {
      const s = strOf(n.initializer);
      if (s != null && /^[A-ZÀ-Ý]/.test(s) && /\s|^[A-Z][a-z]+$/.test(s))
        add(n.initializer, "prop:" + n.name.getText(sf), s);
    }
    ts.forEachChild(n, v);
  })(sf);
}

const key = (r) => `${r.file}\u0000${r.text}`;
const found = [...new Map(res.map((r) => [key(r), r])).values()].sort((a, b) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
);

if (process.argv.includes("--update")) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      found.map(({ file, text }) => ({ file, text })),
      null,
      1
    ) + "\n"
  );
  console.log(`baseline: ${found.length} known string(s)`);
  process.exit(0);
}

const known = new Set(JSON.parse(fs.readFileSync(BASELINE, "utf8")).map(key));
const fresh = found.filter((r) => !known.has(key(r)));
const gone = [...known].filter((k) => !found.some((r) => key(r) === k)).length;
console.log(
  `  ${found.length} hard-coded string(s) found, ${known.size} in the baseline, ${gone} of those now translated or gone`
);
for (const r of fresh)
  console.log(`  FAIL new hard-coded text: ${r.file}:${r.line} (${r.kind}) "${r.text.slice(0, 90)}"`);
console.log(`\n  ${fresh.length ? 0 : 1} passed, ${fresh.length ? 1 : 0} failed`);
process.exit(fresh.length ? 1 : 0);
