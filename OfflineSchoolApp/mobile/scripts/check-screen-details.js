// mobile/scripts/check-screen-details.js
"use strict";

/**
 * Display fixes from the detail check (docs/39 §20.0), held by the source:
 * no screen here can be rendered in a test (jest is not installed, and a
 * component tree has no layout to measure), so what each fix put in place is
 * asserted where it lives.
 *
 *   - the six message screens clear the status and navigation bars
 *     (useScreenInsets): Android draws edge-to-edge, iOS has the notch;
 *   - the thread hides its composer in a read-only conversation (the server
 *     refuses replies there), and a failed message is retried by a tap;
 *   - times and dates in the app's language, not the phone's;
 *   - the conversation list reloads when it comes back into view;
 *   - a guardian's resend of the same text carries the same clientId;
 *   - the portal's six tabs scroll rather than wrap at 360 px;
 *   - the pupil-result screen has no fixed-width box wider than its column,
 *     and prints decimals the French way in French.
 *
 *   node scripts/check-screen-details.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = process.env.CHECK_ROOT || path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const MESSAGE_SCREENS = [
  "app/messages/index.js", "app/messages/[id].js", "app/messages/new.js",
  "app/portal/messages/[id].js", "app/portal/messages/new.js",
];

console.log("--- message screens ---");
check("every message screen clears the system bars",
  MESSAGE_SCREENS.filter((f) => !/useScreenInsets\(/.test(read(f)) || !/pad\.paddingTop/.test(read(f))), []);
check("no message screen formats a time with the phone's locale",
  MESSAGE_SCREENS.filter((f) => /toLocale(Time|Date)String\(\[\]/.test(read(f))), []);

const thread = read("app/messages/[id].js");
check("the thread offers no composer in a read-only conversation",
  [/getConversation\(id\)/.test(thread), /readOnly \? \(/.test(thread), thread.indexOf("readOnly ? (") < thread.indexOf("style={[s.composer")], [true, true, true]);
check("a failed message is retried by a tap", /onPress=\{\(\) => handleRetry\(item\._id\)\}/.test(thread) && /MessageService\.retrySend\(/.test(thread), true);
check("the attachment fallback is translated", /"attachment"/.test(thread), false);
check("the composer and header pad for the insets",
  [/s\.composer, \{ paddingBottom: 10 \+ pad\.paddingBottom \}/.test(thread), /s\.header, \{ paddingTop: 12 \+ pad\.paddingTop \}/.test(thread)], [true, true]);

check("the conversation list reloads on focus", /useFocusEffect\(useCallback\(\(\) => \{ loadLocal\(\); \}/.test(read("app/messages/index.js")), true);

const guardian = read("app/portal/messages/[id].js");
check("a guardian's message goes with a clientId, kept for a resend of the same text",
  [/PortalService\.sendMessage\(id, body, pendingSend\.current\.clientId\)/.test(guardian), /pendingSend\.current\.body !== body/.test(guardian)], [true, true]);
check("a successful reload clears an earlier load error", /setReads\(payload\.participantReads \?\? \[\]\);\s*setError\(null\);/.test(guardian), true);
check("the portal service sends the clientId", /clientId \? \{ body, clientId \} : \{ body \}/.test(read("src/services/portal.service.js")), true);

check("a report card names the child, so a second child's card is found (404 \"Result not found\" before)",
  [/fetchReportCardHtml = async \(summaryId, studentId = null\)/.test(read("src/services/portal.service.js")),
   /fetchReportCardHtml\(summary\._id, childId \?\? me\?\.selectedId\)/.test(read("app/portal/index.js"))], [true, true]);

console.log("--- portal navigation ---");
// Six tabs in a sideways scroll across the top became five sections in a bar
// along the bottom (the redesign). What the old check guarded still holds: a
// label is one line and shrinks before it wraps mid-word.
const portal = read("app/portal/index.js");
const tabsBar = read("src/components/portal/BottomTabs.js");
check("the five sections sit in a bottom bar, each label one line",
  [/<BottomTabs\b/.test(portal), (tabsBar.match(/\{ key: "\w+",/g) ?? []).length,
   /numberOfLines=\{1\}\s*adjustsFontSizeToFit/.test(tabsBar), /<ScrollView horizontal[^>]*styles\.tabsRow/.test(portal)],
  [true, 5, true, false]);
check("Messages' three lists are one segmented row, one line each",
  [/const MSG_VIEWS = \["messages", "notices", "news"\]/.test(portal), /styles\.segmentTextOn\]\} numberOfLines=\{1\}/.test(portal)], [true, true]);

console.log("--- the pupil-result screen (changed on this branch) ---");
const result = read("app/admin/exams/results/[examId]/student/[studentId].js");
check("no fixed 52 px coefficient box", /width:\s*52\b/.test(result), false);
check("decimals through the app's locale (12,50 in French), not toFixed", [/\.toFixed\(/.test(result), /formatDecimal\(/.test(result)], [false, true]);

console.log("--- the admin exams list ---");
const examsList = read("app/admin/exams/index.js");
check("every exam, every page, in a virtualised list (not a ScrollView of page 1)",
  [/ExamService\.getAllExams\(/.test(examsList), /<FlatList\s+data=\{filtered\}/.test(examsList), /filtered\.map\(\(exam\)/.test(examsList)], [true, true, false]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
