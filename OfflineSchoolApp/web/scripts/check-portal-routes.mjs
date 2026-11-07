// web/scripts/check-portal-routes.mjs
//
// The guardian portal: its sections are URLs, its Messages badge counts what
// the section shows, and its browser tab names the school.
//
// The failures this pins:
//   - the Messages tab carried a 1 while the section said "No conversations
//     yet": the badge added unread notices to unread threads, and the section
//     opened on Conversations whatever the badge was counting;
//   - Results, Attendance, Fees and Messages were in-page state, so a refresh
//     dropped the parent on Home, no link could point at a section, and back
//     left the portal;
//   - the tab read "My School On The Move" whichever school it was.
//
//   node scripts/check-portal-routes.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";
import ts   from "typescript";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

let helper = {};
try {
  const { outputText } = ts.transpileModule(read("src/utils/portalRoutes.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  helper = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
} catch (err) {
  check(`src/utils/portalRoutes.ts loads (${err.code ?? err.message})`, false, true);
}
const { portalPath, portalScreenFromPath, messagesBadge, messagesLanding, portalTitle } = helper;
const run = (fn, ...args) => (typeof fn === "function" ? fn(...args) : "missing");

console.log("--- each section has a URL ---");
check("home is /portal",                run(portalPath, "home"), "/portal");
check("results is /portal/results",     run(portalPath, "results"), "/portal/results");
check("attendance is /portal/attendance", run(portalPath, "attendance"), "/portal/attendance");
check("fees is /portal/fees",           run(portalPath, "fees"), "/portal/fees");
check("messages is /portal/messages",   run(portalPath, "messages"), "/portal/messages");

console.log("--- and each URL is its section ---");
for (const s of ["home", "results", "attendance", "fees", "messages"]) {
  check(`${s}: there and back`, run(portalScreenFromPath, run(portalPath, s)), s);
}
check("/portal/ (trailing slash) is home",     run(portalScreenFromPath, "/portal/"), "home");
check("/portal/fees/ is fees",                 run(portalScreenFromPath, "/portal/fees/"), "fees");
check("/portal/nonsense names no section",     run(portalScreenFromPath, "/portal/nonsense"), null);
check("/portal/fees/x names no section",       run(portalScreenFromPath, "/portal/fees/x"), null);
check("/portal-codes is not the portal",       run(portalScreenFromPath, "/portal-codes"), null);

console.log("--- the Messages badge ---");
// The reported state: no thread at all, one unread gate notice.
const reported = { unreadMessages: 0, unreadNotices: 1, unread: { messages: 0, notices: 1, total: 1 } };
check("one unread notice, no threads: badge 1",        run(messagesBadge, reported), 1);
check("...and the section opens on Notices, where it is", run(messagesLanding, reported), "notices");
const threads = { unreadMessages: 2, unreadNotices: 1, unread: { messages: 2, notices: 1, total: 3 } };
check("unread threads: the section opens on Conversations", run(messagesLanding, threads), "messages");
check("the badge is the server's total",               run(messagesBadge, threads), 3);
check("nothing unread: no badge, Conversations",       [run(messagesBadge, { unread: { messages: 0, notices: 0, total: 0 } }), run(messagesLanding, {})], [0, "messages"]);
check("an older server (two halves only) still badges", run(messagesBadge, { unreadMessages: 0, unreadNotices: 1 }), 1);
check("...and still opens on Notices",                 run(messagesLanding, { unreadMessages: 0, unreadNotices: 1 }), "notices");
check("no /me yet: 0",                                  run(messagesBadge, undefined), 0);

console.log("--- the tab title ---");
check("the school's name",            run(portalTitle, "Geneva Bilingual Academy", "My School On The Move"), "Geneva Bilingual Academy");
check("unknown: what it said before", run(portalTitle, null, "My School On The Move"), "My School On The Move");
check("blank: what it said before",   run(portalTitle, "   ", "My School On The Move"), "My School On The Move");

console.log("--- the page ---");
const app  = read("src/App.tsx");
const page = read("src/pages/portal/index.tsx");
const msgs = read("src/pages/portal/MessagesScreen.tsx");
check("App mounts the portal for every path under /portal",
  /<Route\s+path="\/portal\/\*"\s+element=\{page\(<ParentPortalPage \/>\)\}/.test(app), true);
check("the section is read from the URL, not kept in state",
  /portalScreenFromPath\(pathname\)/.test(page) && !/useState<PortalScreen>/.test(page) && !/setScreen\(/.test(page), true);
check("the nav navigates to the section's URL",
  /navigate\(portalPath\(next\)\)/.test(page), true);
check("a path naming no section goes back to /portal",
  /screen === null\) return <Navigate to=\{PORTAL_BASE\} replace \/>/.test(page), true);
check("the badge is messagesBadge(/me), not the client adding two counts",
  /badge: messagesBadge\(meQ\.data\)/.test(page) && !/unreadMessages \+ unreadNotices/.test(page), true);
check("Messages opens on the tab the badge counted",
  /initialView=\{messagesLanding\(meQ\.data\)\}/.test(page) && /useState<MsgView>\(initialView\)/.test(msgs), true);
check("the tab is titled from the school's name, and restored on leaving",
  /document\.title = portalTitle\(schoolName, baseTitle\)/.test(page) && /return \(\) => \{ document\.title = baseTitle; \}/.test(page), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
