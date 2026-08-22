// web/scripts/i18n-hooks.mjs
//
// Makes sure every React component that calls t() actually has it in scope.
//
// The string-replacement pass adds the hook to one component per file, but
// these pages define several — a card, a modal, a row — and each needs its own
// `const { t } = useTranslation()`. Guessing where a function body starts with
// a regex is what put a hook inside a nested arrow function on one page, so
// this walks the AST instead.
//
// It also refuses to touch a plain function: calling a hook outside a component
// is a Rules-of-Hooks violation that only shows up at runtime. "Component" here
// means a function whose name starts with a capital letter, or a hook (useX) —
// the same rule React itself applies.
//
// Usage: node scripts/i18n-hooks.mjs <file...>

import { readFileSync, writeFileSync } from "node:fs";
import { parse }                       from "@babel/parser";
import _traverse                       from "@babel/traverse";

const traverse = _traverse.default ?? _traverse;

const HOOK = "  const { t } = useTranslation();";

const isComponentName = (name) =>
  typeof name === "string" && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name));

const nameOfFunction = (fnPath) =>
  fnPath?.node.id?.name ??
  (fnPath?.parentPath?.node.type === "VariableDeclarator"
    ? fnPath.parentPath.node.id?.name
    : undefined);

for (const file of process.argv.slice(2)) {
  let src = readFileSync(file, "utf8");
  const crlf = src.includes("\r\n");
  if (crlf) src = src.replace(/\r\n/g, "\n");

  const ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"] });

  // ── Pass 1: drop hooks that landed inside a nested, non-component function ──
  const removals = [];
  traverse(ast, {
    VariableDeclarator(path) {
      const { id, init } = path.node;
      const isHook =
        id.type === "ObjectPattern" &&
        id.properties.some((pr) => pr.key?.name === "t") &&
        init?.type === "CallExpression" &&
        init.callee?.name === "useTranslation";
      if (!isHook) return;

      if (!isComponentName(nameOfFunction(path.getFunctionParent()))) {
        removals.push([path.parentPath.node.start, path.parentPath.node.end]);
      }
    },
  });

  // Removing and inserting in one pass would invalidate the offsets, so a file
  // needing a removal is written out here and picked up on the next run.
  if (removals.length) {
    removals.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of removals) {
      src = src.slice(0, s) + src.slice(e).replace(/^[ \t]*\r?\n/, "");
    }
    writeFileSync(file, crlf ? src.replace(/\n/g, "\r\n") : src, "utf8");
    console.log(`  ${file}: removed ${removals.length} misplaced hook(s) — run again to insert`);
    continue;
  }

  // ── Pass 2: give every component that needs it a hook ──────────────────────
  const inserts = [];
  const wraps   = [];

  const considerFunction = (path, name) => {
    if (!isComponentName(name)) return;

    const body = path.get("body");

    let usesT = false;
    path.traverse({
      CallExpression(p) {
        if (p.node.callee.type === "Identifier" && p.node.callee.name === "t") usesT = true;
      },
    });
    if (!usesT) return;

    // A concise-body arrow — `const Card = (props) => (<div/>)` — has nowhere
    // to put a statement, so it gets promoted to a block body with a return.
    // Several of these pages define their cards and panels this way.
    if (!body.isBlockStatement()) {
      wraps.push([body.node.start, body.node.end]);
      return;
    }

    // Only a declaration in THIS function's own body counts. Looking into
    // nested scopes too was the bug: a hook the regex pass had dropped inside a
    // nested arrow read as "already declared", so the component itself never
    // got one and every other t() in the file was out of scope.
    const declaresT = body.node.body.some(
      (stmt) =>
        stmt.type === "VariableDeclaration" &&
        stmt.declarations.some(
          (dec) =>
            dec.id.type === "ObjectPattern" &&
            dec.id.properties.some((pr) => pr.key?.name === "t" || pr.value?.name === "t")
        )
    );

    if (!declaresT) inserts.push(body.node.start + 1);
  };

  traverse(ast, {
    FunctionDeclaration(path) {
      considerFunction(path, path.node.id?.name);
    },
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!init) return;
      if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") return;
      considerFunction(path.get("init"), path.node.id?.name);
    },
  });

  if (!inserts.length && !wraps.length) {
    console.log(`  ${file}: no components needed the hook`);
    continue;
  }

  // Apply from the end of the file backwards so earlier offsets stay valid.
  const edits = [
    ...inserts.map((at) => ({ at, kind: "insert" })),
    ...wraps.map(([s, e]) => ({ at: s, end: e, kind: "wrap" })),
  ].sort((a, b) => b.at - a.at);

  for (const edit of edits) {
    if (edit.kind === "insert") {
      src = src.slice(0, edit.at) + "\n" + HOOK + src.slice(edit.at);
    } else {
      // Babel's body node starts at the expression, not at the parentheses
      // wrapping it, so replacing just [start, end] left `=> ( { … } )` —
      // a block inside parens, which does not parse. Swallow as many
      // surrounding parens as there are, from both sides.
      let s = edit.at;
      let e = edit.end;
      let depth = 0;
      for (;;) {
        let probe = s - 1;
        while (probe >= 0 && /\s/.test(src[probe])) probe--;
        if (src[probe] !== "(") break;
        s = probe;
        depth++;
      }
      for (let i = 0; i < depth; i++) {
        let probe = e;
        while (probe < src.length && /\s/.test(src[probe])) probe++;
        if (src[probe] !== ")") break;
        e = probe + 1;
      }

      const expr = src.slice(edit.at, edit.end);
      src =
        src.slice(0, s) +
        "{\n" + HOOK + "\n  return " + expr + ";\n}" +
        src.slice(e);
    }
  }

  if (!/from\s+["']react-i18next["']/.test(src)) {
    const imports = [...src.matchAll(/^import .*?;$/gm)];
    if (imports.length) {
      const last = imports[imports.length - 1];
      const at = last.index + last[0].length;
      src = src.slice(0, at) + `\nimport { useTranslation } from "react-i18next";` + src.slice(at);
    }
  }

  writeFileSync(file, crlf ? src.replace(/\n/g, "\r\n") : src, "utf8");
  console.log(`  ${file}: hook added to ${inserts.length + wraps.length} component(s)`);
}
