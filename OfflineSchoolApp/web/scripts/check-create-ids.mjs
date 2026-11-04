// web/scripts/check-create-ids.mjs
//
// Class, subject and teacher-assignment creates carry a client id.
//
// On the desktop these three creates are answered by the local database only
// when the request names the id the row is to have (desktop/src/main/api/
// writes/{classes,subjects,assignments}.js); without one the handler declines
// and the request goes to the network, which offline is not there. The server
// takes the same id and answers a repeat with the row it already has, so in a
// browser nothing changes except that a retried create cannot make two rows.
//
//   the id is a UUID                       the server stores it as _id
//   kept while one payload is retried      a lost answer cannot create twice
//   renewed once it succeeds               the next identical create is new
//   one per row in a multi-row submit      three classes, three subjects
//   every create path sends one            or that screen still fails offline
//
//   node scripts/check-create-ids.mjs

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

const load = async (rel) => {
  const { outputText } = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

console.log("--- the helper ---");
let mod = null;
try { mod = await load("src/lib/clientId.ts"); }
catch (err) { check(`src/lib/clientId.ts loads (${err.code ?? err.message})`, false, true); }

if (mod) {
  const { createIds, newClientId, withClientId } = mod;
  check("a fresh id is a v4 UUID", UUID.test(newClientId()), true);
  check("two fresh ids differ", newClientId() !== newClientId(), true);

  const ids = createIds();
  const p = { name: "P4", schoolId: "s1" };
  const first = ids.forAttempt(p);
  check("the attempt id is a UUID", UUID.test(first), true);
  check("a retry of the same payload keeps the id", ids.forAttempt({ name: "P4", schoolId: "s1" }), first);
  const other = ids.forAttempt({ name: "P5", schoolId: "s1" });
  check("a different payload gets a different id", other !== first, true);
  check("the first is still kept while unsent", ids.forAttempt(p), first);
  ids.created(p);
  const next = ids.forAttempt(p);
  check("after success the same payload is a new row, new id", next !== first, true);
  check("and the other pending attempt is untouched", ids.forAttempt({ name: "P5", schoolId: "s1" }), other);
  ids.created();
  check("created() with no payload forgets them all",
    [ids.forAttempt(p) !== next, ids.forAttempt({ name: "P5", schoolId: "s1" }) !== other], [true, true]);

  // One submit creating a subject in each of three classes: three ids.
  const multi = createIds();
  const per = ["c1", "c2", "c3"].map((classId) => multi.forAttempt({ name: "Maths", classId }));
  check("one id per row in a multi-row submit", new Set(per).size, 3);
  check("a retry of the submit keeps all three",
    ["c1", "c2", "c3"].map((classId) => multi.forAttempt({ name: "Maths", classId })), per);

  check("withClientId keeps the caller's id", withClientId({ name: "x", id: "given" }).id, "given");
  check("withClientId supplies one when absent", UUID.test(withClientId({ name: "x" }).id), true);

  // A school LAN on plain HTTP: no randomUUID, getRandomValues still there.
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => real.getRandomValues(a) },
  });
  try { check("without randomUUID it is still a v4 UUID", UUID.test(newClientId()), true); }
  finally { Object.defineProperty(globalThis, "crypto", { configurable: true, value: real }); }
}

console.log("--- the services send it ---");
const classSvc = read("src/services/class.service.ts");
check("createClass posts with an id",
  /api\.post\("\/admin\/classes",\s*withClientId\(payload\)\)/.test(classSvc), true);
check("class.service createSubject posts with an id",
  /api\.post\("\/admin\/subjects",\s*withClientId\(payload\)\)/.test(classSvc), true);
const subjectSvc = read("src/services/subject.service.ts");
check("subject.service createSubject posts with an id",
  /"\/admin\/subjects",\s*withClientId\(payload\)/.test(subjectSvc), true);
const assignSvc = read("src/services/assignment.service.ts");
check("createAssignment posts with an id",
  /api\.post\(API\.admin\.assignments\.list,\s*withClientId\(payload\)\)/.test(assignSvc), true);

console.log("--- the screens keep one per attempt ---");
const classes = read("src/pages/classes/ClassesPage.tsx");
check("a new class is created under its attempt id",
  /createClass\(\{[^}]*id:\s*classIds\.current\.forAttempt\(/.test(classes), true);
check("a new subject (classes page) likewise",
  /createSubject\(\{[^}]*id:\s*subjectIds\.current\.forAttempt\(/.test(classes), true);
check("both are renewed on success",
  [/classIds\.current\.created\(\)/.test(classes), /subjectIds\.current\.created\(\)/.test(classes)], [true, true]);

const addSubject = read("src/pages/subjects/add/index.tsx");
check("the add-subject page sends an id per class",
  /id:\s*subjectIds\.current\.forAttempt\(attempt\)/.test(addSubject), true);
check("and renews each one that was created",
  /subjectIds\.current\.created\(attempt\)/.test(addSubject), true);

const editTeacher = read("src/pages/teachers/EditTeacherPage.tsx");
check("assigning a subject to a teacher sends an id",
  /api\.post\("\/admin\/assignments",\s*\{\s*\.\.\.attempt,\s*id:\s*assignIds\.current\.forAttempt\(attempt\)/.test(editTeacher), true);
check("and renews it once the assignment is shown",
  /assignIds\.current\.created\(attempt\)/.test(editTeacher), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
