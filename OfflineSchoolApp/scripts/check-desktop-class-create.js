// Behavioural check for the offline class-create mirror (writes/classes.js):
// the class-teacher shapes must match what POST /admin/classes does on the
// server, and level/section must be stored the way the endpoint stores them.
//   node scripts/check-desktop-class-create.js
// Exits 0 when every case passes, 1 with a message otherwise.
const path = require("path");

const ROOT = path.join(__dirname, "..");
const handlers = require(path.join(ROOT, "desktop", "src", "main", "api", "writes", "classes.js"));
const createHandler = handlers.find((h) => h.route === "POST /api/admin/classes");
if (!createHandler) {
  console.error("FAIL POST /api/admin/classes handler not found in writes/classes.js");
  process.exit(1);
}

// A minimal mirror. docs.get / docs.find are the only APIs the handler uses.
const docs = {
  store: {
    class: {
      c1: { _id: "c1", name: "Form 1", schoolId: "s1", isActive: true },
    },
    user: {
      u1: { _id: "u1", name: "Ada Mentors", schoolId: "s1" },
      u2: { _id: "u2", name: "Bob Elsewhere", schoolId: "s2" },
    },
  },
  get(collection, id) {
    return this.store[collection]?.[String(id)] ?? null;
  },
  find(collection, query) {
    return Object.values(this.store[collection] ?? {}).filter((row) =>
      Object.entries(query).every(([k, v]) => row[k] === v)
    );
  },
};

const session = { schoolId: "s1", permissions: ["classes.manage"] };
const run = (body) => createHandler.handler({ body }, { docs, session });

const cases = [
  {
    label: "no teacher field → teacher stays null (server: absent contributes nothing)",
    body: { id: "n1", name: "Alpha", schoolId: "s1" },
    expect: (r) => r?.doc?.classTeacherId === null && r?.doc?.classTeacherName === null,
  },
  {
    label: "empty teacher id → teacher cleared to null",
    body: { id: "n2", name: "Beta", schoolId: "s1", classTeacherId: "" },
    expect: (r) => r?.doc?.classTeacherId === null && r?.doc?.classTeacherName === null,
  },
  {
    label: "teacher this school has → id AND name stored",
    body: { id: "n3", name: "Gamma", schoolId: "s1", classTeacherId: "u1" },
    expect: (r) => r?.doc?.classTeacherId === "u1" && r?.doc?.classTeacherName === "Ada Mentors",
  },
  {
    label: "teacher of another school → declined (the server's 403)",
    body: { id: "n4", name: "Delta", schoolId: "s1", classTeacherId: "u2" },
    expect: (r) => r === null,
  },
  {
    label: "teacher that does not exist → declined",
    body: { id: "n5", name: "Epsilon", schoolId: "s1", classTeacherId: "zz" },
    expect: (r) => r === null,
  },
  {
    label: "level stored as-is, section trimmed like the endpoint",
    body: { id: "n6", name: "Zeta", schoolId: "s1", level: "10", section: "  A  " },
    expect: (r) => r?.doc?.level === "10" && r?.doc?.section === "A",
  },
  {
    label: "blank level → null, like the server's level || null",
    body: { id: "n7", name: "Eta", schoolId: "s1", level: "" },
    expect: (r) => r?.doc?.level === null,
  },
  {
    label: "no id → declined (the mirror only answers idempotent creates)",
    body: { name: "Theta", schoolId: "s1" },
    expect: (r) => r === null,
  },
  {
    label: "duplicate name → declined (the server's 409)",
    body: { id: "n8", name: "Form 1", schoolId: "s1" },
    expect: (r) => r === null,
  },
  {
    label: "queued request body preserved verbatim",
    body: { id: "n9", name: "Iota", schoolId: "s1", classTeacherId: "u1", level: "12" },
    expect: (r) =>
      r?.request?.body?.classTeacherId === "u1" && r?.request?.body?.level === "12",
  },
];

let failed = false;
for (const c of cases) {
  let result;
  try {
    result = run(c.body);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${c.label}: threw ${err.message}`);
    continue;
  }
  if (c.expect(result)) {
    console.log(`OK   ${c.label}`);
  } else {
    failed = true;
    console.error(`FAIL ${c.label}`);
  }
}

process.exit(failed ? 1 : 0);
