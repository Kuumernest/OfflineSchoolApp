// mobile/scripts/check-marks-entry.js
"use strict";

/**
 * Marks entry, typed at speed.
 *
 * "I typed 16 and got 6." Two things had to be true for that to happen, and
 * both were true of every mark box on both entry screens.
 *
 * The box was a controlled TextInput whose value came out of one `scores`
 * object in an 1,800-line screen component, so a keystroke re-rendered the
 * screen, the FlatList and every visible row — an inline renderItem with no
 * memo boundary — plus a recount of the entered marks and the 30-second draft
 * timer. And on the first digit the row gave the box a thicker border and a
 * "%" badge, which is a layout pass; with selectTextOnFocus, Android's
 * ReactEditText selects ALL of a focused box's text on its first layout pass
 * (ReactEditText.kt, onLayout). So the "1" was selected the moment it landed,
 * and the "6" replaced it. The slow render only decided when.
 *
 * What runs here is the real row (src/components/MarkInputRow.js) and the real
 * draft hook (src/hooks/useMarkDrafts.js), through babel, rendered with
 * react-test-renderer against a TextInput modelled on the two pieces of React
 * Native that decide what the teacher sees:
 *
 *   TextInput.js      the JS wrapper: remembers the last text native reported
 *                     and pushes `value` down only when the two differ;
 *   ReactEditText.kt  the Android view: applies a push only if JS is up to
 *                     date with its event counter, and — with
 *                     selectTextOnFocus — selects everything on the first
 *                     layout pass while focused.
 *
 * The old row structure is rebuilt here as well, so the failure is shown
 * rather than described and the render counts have a "before".
 *
 *   node scripts/check-marks-entry.js
 */

const fs    = require("fs");
const path  = require("path");
const babel = require("@babel/core");
const React = require("react");
const TestRenderer = require("react-test-renderer");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

// ─────────────────────────────────────────────────────────────────────────────
// A phone's TextInput, modelled from the source it wraps
// ─────────────────────────────────────────────────────────────────────────────

// Native state per box: what the EditText holds, independent of React.
const natives = new Map();
const nativeFor = (id) => {
  if (!natives.has(id)) {
    natives.set(id, {
      text: "", eventCount: 0, focused: false,
      armed: false,        // selectTextOnFocus's one-shot "select on next layout"
      selectedAll: false,  // the next key replaces the whole text
      layoutSig: undefined, handlers: {},
    });
  }
  return natives.get(id);
};

const LAYOUT_KEYS = [
  "borderWidth", "width", "height", "minWidth", "minHeight",
  "padding", "paddingHorizontal", "paddingVertical", "margin", "marginTop", "fontSize",
];
const flatten = (style) =>
  Array.isArray(style)
    ? style.reduce((acc, s) => ({ ...acc, ...flatten(s) }), {})
    : style && typeof style === "object" ? style : {};
const layoutSignature = (style) => {
  const f = flatten(style);
  return JSON.stringify(LAYOUT_KEYS.map((k) => f[k]));
};

let inputRenders = 0;
const rendersById = new Map();

function TextInputStub(props) {
  const id = props.testID;
  inputRenders++;
  rendersById.set(id, (rendersById.get(id) ?? 0) + 1);
  const native = nativeFor(id);

  // TextInput.js: push `value` to native only when it differs from the last
  // text native reported; ReactEditText.maybeSetText applies it only when JS
  // is up to date with the native event counter.
  const [lastNativeText, setLastNativeText] = React.useState(props.value);
  const [eventCount,     setEventCount]     = React.useState(0);
  React.useLayoutEffect(() => {
    if (lastNativeText !== props.value && typeof props.value === "string") {
      setLastNativeText(props.value);
      if (eventCount >= native.eventCount) native.text = props.value;
    }
  });

  // ReactEditText.onLayout: a layout-affecting change while focused and armed
  // selects everything, once.
  const sig = layoutSignature(props.style);
  React.useLayoutEffect(() => {
    const changed = native.layoutSig !== undefined && native.layoutSig !== sig;
    native.layoutSig = sig;
    if (changed && native.focused && native.armed) {
      native.selectedAll = native.text.length > 0;
      native.armed = false;
    }
  });

  native.handlers = {
    ...props,
    reportChange: (text, count) => { setLastNativeText(text); setEventCount(count); },
  };
  return React.createElement("TextInput", props);
}

// One key on the keypad, as the native side would report it. Not wrapped in
// act(): the caller decides whether JS gets to run between keys.
const press = (id, ch) => {
  const n = nativeFor(id);
  if (n.handlers.editable === false) return;
  if (ch === "\b") n.text = n.selectedAll ? "" : n.text.slice(0, -1);
  else             n.text = n.selectedAll ? ch : n.text + ch;
  n.selectedAll = false;
  n.eventCount += 1;
  const text = n.text, count = n.eventCount;
  // TextInput.js _onChange: onChangeText first, then its own bookkeeping.
  n.handlers.onChangeText?.(text);
  n.handlers.reportChange(text, count);
};
/** Keys with JS catching up between them — ordinary fast typing. */
const type  = (id, keys) => { for (const ch of keys) act(() => press(id, ch)); };
/** Keys that all land before JS runs once — typing faster than the thread. */
const burst = (id, keys) => act(() => { for (const ch of keys) press(id, ch); });

const focusRaw = (id) => {
  const n = nativeFor(id);
  n.focused = true;
  n.armed   = Boolean(n.handlers.selectTextOnFocus);
  // Android setSelectAllOnFocus: text present on focus is selected outright.
  n.selectedAll = n.armed && n.text.length > 0;
};
const focus  = (id) => act(() => { focusRaw(id); n_focus(id); });
const n_focus = (id) => nativeFor(id).handlers.onFocus?.();
const blur   = (id) => act(() => {
  const n = nativeFor(id); n.focused = false; n.selectedAll = false; n.handlers.onBlur?.();
});
const submit = (id) => act(() => nativeFor(id).handlers.onSubmitEditing?.());
const shown  = (root, id) =>
  root.root.findAll((n) => n.type === TextInputStub && n.props.testID === id)[0]?.props.value;
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

const RN = {
  View: "View", Text: "Text", TouchableOpacity: "TouchableOpacity",
  TextInput: TextInputStub,
  StyleSheet: { create: (s) => s, flatten },
  Platform: { OS: "android" },
  FlatList: ({ data, renderItem, keyExtractor }) =>
    React.createElement(React.Fragment, null,
      data.map((item, index) =>
        React.createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })))),
};

/** Load one ESM module out of mobile/ with a require we control. */
const loadModule = (rel, stubs) => {
  const abs = path.join(MOBILE, rel);
  const { code } = babel.transformFileSync(abs, {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false, configFile: false,
  });
  const dir = path.dirname(abs);
  const mod = { exports: {} };
  const req = (id) => (id in stubs ? stubs[id] : require(id.startsWith(".") ? path.resolve(dir, id) : id));
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

const { MarkInputRow } = loadModule("src/components/MarkInputRow.js", { "react-native": RN });
const { useMarkDrafts, COMMIT_DELAY_MS } = loadModule("src/hooks/useMarkDrafts.js", {});

// The admin screen's sanitiser, lifted out of the screen so the real rule is
// what is tested here.
const adminSrc = fs.readFileSync(path.join(MOBILE, "app/admin/exams/marks.js"), "utf8");
const sanMatch = /const sanitizeScore = \(v\) => \{[\s\S]*?\n\};/.exec(adminSrc);
const sanitizeScore = sanMatch
  ? new Function(`return ${sanMatch[0].replace("const sanitizeScore = ", "")}`)()
  : null;

const settle = async () => { await act(async () => { await sleep(COMMIT_DELAY_MS + 80); }); };

const STUDENTS = Array.from({ length: 30 }, (_, i) => ({
  _id: `s${i + 1}`, studentName: `Student ${i + 1}`, admissionNo: `A-${i + 1}`,
}));
const id = (sid) => `mark-${sid}`;
const MAX = 20;

// ─────────────────────────────────────────────────────────────────────────────
// BEFORE — the old row, rebuilt: parent state controls every box
// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = { borderWidth: 1, width: 60, paddingHorizontal: 8, paddingVertical: 6, fontSize: 15 };
let oldParentRenders = 0;

function OldSheet({ students, maxScore }) {
  const [scores, setScores] = React.useState({});
  oldParentRenders++;
  const updateScore = React.useCallback((sid, value) => {
    setScores((p) => ({ ...p, [sid]: { ...p[sid], score: value } }));
  }, []);
  return React.createElement(RN.FlatList, {
    data: students, keyExtractor: (s) => s._id,
    renderItem: ({ item }) => {
      const entry = scores[item._id] || {};
      const raw   = String(entry.score ?? "");
      const num   = raw !== "" ? Number(raw) : null;
      const pct   = num !== null ? Math.round((num / maxScore) * 100) : null;
      return React.createElement("View", null,
        React.createElement(TextInputStub, {
          testID: id(item._id),
          style:  [BASE_INPUT, num !== null && !entry.isAbsent && { borderColor: "#059669", borderWidth: 1.5 }],
          value:  entry.isAbsent ? "ABS" : raw,
          onChangeText: (v) => { if (!entry.isAbsent) updateScore(item._id, v); },
          editable: !entry.isAbsent, selectTextOnFocus: true, maxLength: 5,
        }),
        pct !== null && !entry.isAbsent ? React.createElement("Text", null, `${pct}%`) : null);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AFTER — the screens' wiring, with the real hook and the real row
// ─────────────────────────────────────────────────────────────────────────────

const ROW_STYLES = {
  row: {}, rowAbsent: {}, avatar: {}, avatarText: {}, info: {}, name: {}, sub: {},
  absBtn: {}, absBtnActive: {}, absBtnText: {}, absBtnTextActive: {},
  scoreWrap: {}, scoreInput: BASE_INPUT, scoreInputAbsent: {}, scorePct: { fontSize: 10 },
};
const rateColor = (pct) => (pct >= 70 ? "#059669" : pct >= 50 ? "#D97706" : "#DC2626");
let newParentRenders = 0;

function NewSheet({ students, maxScore, api, sanitize, initial }) {
  // As the screens do it: dirty flips once, guarded by a ref, so a keystroke
  // while already dirty schedules nothing on this component.
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef  = React.useRef(false);
  React.useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const markDirty = React.useCallback(() => { if (!dirtyRef.current) setDirty(true); }, []);
  const drafts    = useMarkDrafts({ onDirty: markDirty });
  const { scores, generation, draftChanged, flush, readPending, replaceScores, toggleAbsent } = drafts;
  newParentRenders++;

  React.useEffect(() => { api.current = { ...drafts, dirty }; });
  React.useEffect(() => { if (initial) replaceScores(initial); }, [initial, replaceScores]);

  // The teacher screen's "next": commit, then move focus to the next row.
  const onSubmitRow = React.useCallback((sid) => {
    flush();
    const idx = students.findIndex((s) => s._id === sid);
    if (students[idx + 1]) focusRaw(id(students[idx + 1]._id));
  }, [flush, students]);

  const renderRow = React.useCallback(({ item }) => {
    const entry = scores[item._id] || {};
    return React.createElement(MarkInputRow, {
      student: item,
      score: String(entry.score ?? ""),
      isAbsent: Boolean(entry.isAbsent),
      generation, maxScore,
      styles: ROW_STYLES, rateColor,
      neutralColor: "#9CA3AF", placeholderTextColor: "#D1D5DB",
      absLabel: "ABS", unknownName: "?",
      sanitize,
      onDraft: draftChanged, onToggleAbsent: toggleAbsent,
      onBlur: flush, onSubmit: onSubmitRow, readPending,
    });
  }, [scores, generation, maxScore, sanitize, draftChanged, toggleAbsent, flush, onSubmitRow, readPending]);

  return React.createElement(RN.FlatList, { data: students, keyExtractor: (s) => s._id, renderItem: renderRow });
}

const mountNew = (props = {}) => {
  const api = { current: null };
  let root;
  act(() => { root = TestRenderer.create(React.createElement(NewSheet, { students: STUDENTS, maxScore: MAX, api, ...props })); });
  return { root, api };
};

(async () => {
  console.log("\n=== the boxes under test ===");
  note(`${STUDENTS.length} students on screen, max ${MAX}, commit delay ${COMMIT_DELAY_MS} ms`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- BEFORE: the old row, typed into at speed ---");
  {
    let root;
    act(() => { root = TestRenderer.create(React.createElement(OldSheet, { students: STUDENTS, maxScore: MAX })); });
    const box = id("s1");
    natives.clear(); root.root.findAllByType(TextInputStub).forEach((n) => nativeFor(n.props.testID));
    // Re-register handlers after clearing.
    act(() => root.update(React.createElement(OldSheet, { students: STUDENTS, maxScore: MAX })));

    focus(box);                                // keyboard already up: no layout on focus
    const beforeInputs = inputRenders, beforeParent = oldParentRenders;
    type(box, "1");
    const perKey = inputRenders - beforeInputs;
    note(`one keystroke re-rendered ${perKey} mark boxes and the parent ${oldParentRenders - beforeParent} time(s)`);
    if (perKey === STUDENTS.length) ok(`every one of the ${STUDENTS.length} boxes re-rendered for a key typed into one of them`);
    else bad("the old structure re-renders every row per keystroke", `${perKey} of ${STUDENTS.length}`);

    const n = nativeFor(box);
    if (n.selectedAll) ok("the first digit changed the box's frame (borderWidth 1 → 1.5); the layout pass selected it");
    else bad("the old row's first digit triggers select-all on layout", JSON.stringify(n));
    type(box, "6");
    if (n.text === "6" && shown(root, box) === "6") ok("REPRODUCED: 1 then 6 leaves the box showing \"6\"");
    else bad("the old row reproduces 16 → 6", `native=${n.text} shown=${shown(root, box)}`);
    act(() => root.unmount());
    natives.clear(); rendersById.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- AFTER: 1 then 6, JS keeping up between keys ---");
  const { root, api } = mountNew();
  root.root.findAllByType(TextInputStub).forEach((n) => nativeFor(n.props.testID));
  act(() => root.update(React.createElement(NewSheet, { students: STUDENTS, maxScore: MAX, api })));
  {
    const box = id("s1");
    focus(box);
    const i0 = inputRenders, p0 = newParentRenders;
    type(box, "1");
    const perKey = inputRenders - i0;
    if (perKey === 1) ok("one keystroke re-rendered exactly one box");
    else bad("only the typed-into row renders", `${perKey} boxes rendered`);
    const dirtyRenders = newParentRenders - p0;
    if (dirtyRenders <= 1) ok(`the first key rendered the parent ${dirtyRenders} time(s): the dirty flag flipping, nothing else`);
    else bad("the first key renders the parent at most once", `${dirtyRenders} render(s)`);
    if (!nativeFor(box).selectedAll) ok("the box's frame did not change, so nothing got selected");
    else bad("no select-all after the first digit");
    const p1 = newParentRenders, i1 = inputRenders;
    type(box, "6");
    if (newParentRenders === p1 && inputRenders - i1 === 1) ok("the second key: one box render, zero parent renders");
    else bad("the parent stays out of the keystroke path", `parent ${newParentRenders - p1}, boxes ${inputRenders - i1}`);
    if (nativeFor(box).text === "16" && shown(root, box) === "16") ok("1 then 6 → \"16\", on screen and in the native field");
    else bad("1 then 6 is 16", `native=${nativeFor(box).text} shown=${shown(root, box)}`);
    if (api.current.dirty === true) ok("the screen is marked dirty on the first key, not on the commit");
    else bad("dirty flips immediately");
    if (!api.current.scores.s1) ok(`the screen's scores are untouched ${COMMIT_DELAY_MS} ms after the first key (no commit, no persistence path)`);
    else bad("no commit inside the delay", JSON.stringify(api.current.scores.s1));
    await settle();
    if (api.current.scores.s1?.score === "16") ok("one commit later, scores.s1 is \"16\" — text, not a Number");
    else bad("the commit lands", JSON.stringify(api.current.scores.s1));
    if (shown(root, box) === "16") ok("and the box still shows 16 after its own echo came back");
    else bad("the echo does not disturb the box", shown(root, box));
  }

  console.log("\n--- 16 typed faster than the JS thread runs ---");
  {
    const box = id("s2");
    focus(box);
    burst(box, "16");
    if (nativeFor(box).text === "16" && shown(root, box) === "16") ok("both keys land before React runs once → \"16\"");
    else bad("a burst of 1,6 is 16", `native=${nativeFor(box).text} shown=${shown(root, box)}`);
  }

  console.log("\n--- replace 16 with 18, quickly ---");
  {
    const box = id("s1");
    blur(box); focus(box);
    if (nativeFor(box).selectedAll) ok("tapping a filled box selects it (selectTextOnFocus kept)");
    else bad("selectTextOnFocus still selects a filled box on focus");
    type(box, "1");
    type(box, "8");
    if (shown(root, box) === "18" && nativeFor(box).text === "18") ok("1 then 8 → \"18\"");
    else bad("replacing 16 with 18", `native=${nativeFor(box).text} shown=${shown(root, box)}`);
    await settle();
    if (api.current.scores.s1?.score === "18") ok("committed as \"18\"");
    else bad("18 commits", JSON.stringify(api.current.scores.s1));
  }

  console.log("\n--- delete and re-enter, inside the commit window ---");
  {
    const box = id("s1");
    type(box, "\b\b");
    if (shown(root, box) === "") ok("two deletes → empty");
    else bad("deleting clears the box", shown(root, box));
    type(box, "1");
    type(box, "7");
    if (shown(root, box) === "17") ok("re-entered → \"17\"");
    else bad("re-entry after delete", shown(root, box));
    let snap; act(() => { snap = api.current.flush(); });
    if (snap.s1?.score === "17") ok("flush() right away returns \"17\" — a save inside the window loses nothing");
    else bad("flush returns the latest draft", JSON.stringify(snap.s1));
  }

  console.log("\n--- next, next, next: moving between students quickly ---");
  {
    const a = id("s3"), b = id("s4");
    focus(a);
    type(a, "1");
    submit(a);                                    // flush + focus the next row
    type(b, "9");
    if (shown(root, a) === "1" && shown(root, b) === "9") ok("s3 shows 1, s4 shows 9");
    else bad("moving on keeps both", `${shown(root, a)} / ${shown(root, b)}`);
    if (api.current.scores.s3?.score === "1") ok("\"next\" committed s3 at once");
    else bad("submit flushes", JSON.stringify(api.current.scores.s3));
    await settle();
    if (api.current.scores.s4?.score === "9") ok("s4 followed on its own commit");
    else bad("s4 commits", JSON.stringify(api.current.scores.s4));
    blur(b);
  }

  console.log("\n--- a whole class, one digit each, as fast as it comes ---");
  {
    const i0 = inputRenders, p0 = newParentRenders;
    // Every key lands before React runs once — one act, one batch.
    act(() => {
      for (let i = 5; i <= 30; i++) { focusRaw(id(`s${i}`)); press(id(`s${i}`), "7"); }
    });
    const typed = inputRenders - i0;
    note(`${26} keys → ${typed} box render(s), parent ${newParentRenders - p0} render(s)`);
    if (typed <= 26) ok("no more box renders than keys — no row rendered for another row's key");
    else bad("box renders stay one-per-key", `${typed} renders for 26 keys`);
    if (newParentRenders === p0) ok("the parent rendered zero times while the class was typed");
    else bad("parent renders during typing", String(newParentRenders - p0));
    await settle();
    const committed = Object.keys(api.current.scores).filter((k) => api.current.scores[k]?.score === "7").length;
    if (committed === 26) ok("one commit carried all 26 marks");
    else bad("all marks commit", `${committed} of 26`);
    if (newParentRenders - p0 <= 2) ok(`the parent rendered ${newParentRenders - p0} time(s) in total for 26 marks`);
    else bad("the parent renders once per commit, not per key", String(newParentRenders - p0));
  }

  console.log("\n--- offline: a keystroke touches nothing but the row ---");
  {
    // There is no network, storage or SQLite in this harness at all; the point
    // is structural. The only road from a keystroke to any of those is a
    // commit, and a commit is the only thing that renders the parent.
    const box = id("s5");
    focus(box);
    const p0 = newParentRenders;
    type(box, "\b1");
    if (newParentRenders === p0) ok("two keys: zero parent renders, hence zero commits, hence no persistence path ran");
    else bad("no commit per keystroke", String(newParentRenders - p0));
    await settle();
    if (newParentRenders - p0 === 1 && api.current.scores.s5?.score === "1") ok("the single commit came after the delay");
    else bad("exactly one commit after the delay", `${newParentRenders - p0} render(s), ${JSON.stringify(api.current.scores.s5)}`);
  }

  console.log("\n--- absent, decimals, the admin sanitiser: validation as before ---");
  {
    const box = id("s6");
    focus(box);
    type(box, "\b8");
    act(() => api.current.toggleAbsent("s6"));    // within the window: the 8 is still pending
    if (shown(root, box) === "ABS") ok("marking absent shows ABS");
    else bad("absent label", shown(root, box));
    let snap6; act(() => { snap6 = api.current.flush(); });
    if (snap6.s6?.isAbsent === true && snap6.s6?.score === "") ok("an absent child's pending mark is dropped: score \"\", isAbsent true (→ null on save, as before)");
    else bad("absent clears a pending mark", JSON.stringify(snap6.s6));
    act(() => api.current.toggleAbsent("s6"));
    if (shown(root, box) === "") ok("present again: the box is empty, as before");
    else bad("un-absent leaves the box empty", shown(root, box));

    type(box, "16.5");
    if (shown(root, box) === "16.5") ok("decimals type through: \"16.5\"");
    else bad("decimal support", shown(root, box));
    blur(box);
  }

  console.log("\n--- the echo race: typing on after a commit landed ---");
  {
    const box = id("s8");
    focus(box);
    type(box, "16");
    await settle();                               // commit lands; the row's score prop becomes "16"
    type(box, "5");
    if (shown(root, box) === "165") ok("a key typed after the commit appends: \"165\"");
    else bad("the committed echo does not reset the box", shown(root, box));
    await settle();
    if (shown(root, box) === "165" && api.current.scores.s8?.score === "165") ok("and the second commit carries \"165\"");
    else bad("no regression to 16", `${shown(root, box)} / ${JSON.stringify(api.current.scores.s8)}`);
    blur(box);
  }

  console.log("\n--- reload: server values replace the sheet, rows adopt them ---");
  {
    const box = id("s9");
    focus(box);
    type(box, "3");                               // pending, uncommitted
    act(() => api.current.replaceScores({ s1: { score: 12, isAbsent: false }, s9: { score: 7, isAbsent: false } }));
    if (shown(root, id("s1")) === "12" && shown(root, box) === "7") ok("rows show the loaded values, including over a pending draft");
    else bad("replaceScores is adopted", `${shown(root, id("s1"))} / ${shown(root, box)}`);
    if (shown(root, id("s8")) === "") ok("a row absent from the load is cleared");
    else bad("rows not in the load are cleared", shown(root, id("s8")));
    await settle();
    if (api.current.scores.s9?.score === 7) ok("the discarded draft never committed");
    else bad("pending is dropped by a replace", JSON.stringify(api.current.scores.s9));
    type(box, "\b8");
    if (shown(root, box) === "8") ok("typing after a reload works");
    else bad("typing after reload", shown(root, box));

    act(() => root.unmount());
    natives.clear();
    const initial = { s1: { score: 12, isAbsent: false }, s2: { score: "", isAbsent: true } };
    const { root: r3 } = mountNew({ initial });
    if (shown(r3, id("s1")) === "12" && shown(r3, id("s2")) === "ABS") ok("reopened: saved values and absences render from the load");
    else bad("reopen shows saved values", `${shown(r3, id("s1"))} / ${shown(r3, id("s2"))}`);
    act(() => r3.unmount());
  }

  console.log("\n--- the admin sanitiser, per key, as before ---");
  if (!sanitizeScore) {
    bad("the admin sanitiser can be found in marks.js");
  } else {
    natives.clear();
    const { root: r2 } = mountNew({ sanitize: sanitizeScore });
    const b2 = id("s7");
    focus(b2);
    type(b2, "-1.5.");
    if (shown(r2, b2) === "1.5") ok("admin: \"-1.5.\" shows \"1.5\" — the sign and the second point are stripped as before");
    else bad("the admin sanitiser still applies per key", shown(r2, b2));
    act(() => r2.unmount());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the two screens actually use this ---");
  for (const rel of ["app/teacher/exams/subjects.js", "app/admin/exams/marks.js"]) {
    const src = fs.readFileSync(path.join(MOBILE, rel), "utf8");
    const name = path.basename(rel);
    if (/import \{ useMarkDrafts \}/.test(src) && /import \{ MarkInputRow \}/.test(src)) ok(`${name} imports the hook and the row`);
    else bad(`${name} imports useMarkDrafts and MarkInputRow`);
    if (/renderItem=\{renderRow\}/.test(src)) ok(`${name} renders rows through a memoised renderRow`);
    else bad(`${name} uses renderRow`);
    if (!/updateScore/.test(src)) ok(`${name} has no per-keystroke updateScore left`);
    else bad(`${name} still has updateScore`);
    if (!/borderColor:\s*color,\s*borderWidth:\s*1\.5/.test(src)) ok(`${name} no longer thickens the border on the first digit`);
    else bad(`${name} still changes the box's frame while typing`);
    if (/const current = flush\(\);/.test(src)) ok(`${name} flushes pending drafts before building the save`);
    else bad(`${name} saves through flush()`);
  }
  if (/sanitize=\{sanitizeScore\}/.test(adminSrc)) ok("marks.js passes its sanitiser to the row");
  else bad("marks.js keeps sanitizeScore");

  const rowSrc = fs.readFileSync(path.join(MOBILE, "src/components/MarkInputRow.js"), "utf8");
  if (/selectTextOnFocus/.test(rowSrc)) ok("the row keeps selectTextOnFocus (tap a filled box to overwrite it)");
  else bad("selectTextOnFocus preserved");
  if (!/Number\([^)]*\)\s*\)?\s*;?\s*\n[^\n]*onDraft/.test(rowSrc) && /onDraft\(sid, text\)/.test(rowSrc)) ok("the row hands the parent text, never a Number");
  else bad("no Number conversion in the keystroke path");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
