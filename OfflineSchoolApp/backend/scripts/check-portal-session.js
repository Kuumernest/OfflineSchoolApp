// backend/scripts/check-portal-session.js
"use strict";

/**
 * A parent stays signed in.
 *
 * The portal issued one twelve-hour token and nothing else. The phone treated
 * "holds a token" as "signed in" and any 401 as "sign out", so the first
 * request every morning ended with the sign-in form — and a code that was
 * handed over once, on paper, was being typed daily by people who were never
 * meant to remember it.
 *
 * The code is the credential and the GuardianAccess row is the authorisation;
 * neither was ever the problem, and neither is touched here. What was missing
 * is a SESSION: ninety days per device, held on the row as the hash of an
 * opaque refresh token, renewing a twenty-minute access token as it goes.
 *
 * This script signs in through the real router and checks that the session
 * behaves like one — renews without a code, survives a month offline, ends on
 * sign-out, ends on revocation and re-issue, and does none of it by weakening
 * the controls around the code itself.
 *
 *   node scripts/check-portal-session.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

const DAY = 86_400_000;

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School         = mongoose.model("School");
  const Class          = mongoose.model("Class");
  const Student        = mongoose.model("Student");
  const GuardianAccess = mongoose.model("GuardianAccess");

  const portal = require(path.join(SRC, "services/portal.service"));

  // ── One school, one child, one code ──────────────────────────────────────
  const S = "68c00000000000000000000a";
  await School.create({ _id: S, name: "Check School", email: "office@example.test" });
  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  await Student.create({
    _id: "st-1", userId: "u-1", schoolId: S, classId: "cls-1",
    studentName: "Ama Tem", enrollmentNo: "ADM-001", isActive: true, status: "approved",
  });

  const issued = await portal.issueAccess({
    schoolId: S, studentIds: ["st-1"], label: "Mrs Tem", createdBy: "adm-1",
  });
  const accessId = issued.accessId;
  let code = issued.code;

  const app = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api/portal`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };

  const row     = () => GuardianAccess.findOne({ _id: accessId }).lean();
  const signIn  = () => call("POST", "/login", { body: { admissionNo: "ADM-001", code } });
  const renew   = (refreshToken) => call("POST", "/refresh", { body: { refreshToken } });
  const me      = (token) => call("GET", "/me", { token });
  const sha256  = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const isOk    = (r) => r.status === 200 && r.body?.success === true;
  const refused = (r, code) => r.status === 401 && r.body?.code === code;

  console.log("\n=== the arrangement under test ===");
  note(`access token   ${portal.ACCESS_TOKEN_MINUTES} minutes`);
  note(`session        ${portal.SESSION_DAYS} days, at most ${portal.MAX_SESSIONS} per code`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- sign-in hands out a session, not just a token ---");
  const phone = (await signIn()).body;

  if (phone.token && phone.refreshToken) ok("login returns an access token AND a refresh token");
  else bad("login returns both tokens", JSON.stringify(Object.keys(phone)));

  const claims = jwt.decode(phone.token) ?? {};
  if (claims.aud === "portal" && claims.accessId === accessId && claims.sid) {
    ok("the access token carries aud=portal, the accessId and a session id");
  } else {
    bad("access token claims", JSON.stringify(claims));
  }

  const minutes = (claims.exp - claims.iat) / 60;
  if (minutes === portal.ACCESS_TOKEN_MINUTES && minutes >= 15 && minutes <= 30) {
    ok(`the access token lives ${minutes} minutes — short, and inside the 15-30 band`);
  } else {
    bad("access token lifetime is 15-30 minutes", `${minutes} minutes`);
  }
  if (phone.expiresIn === portal.ACCESS_TOKEN_MINUTES * 60) ok("expiresIn says so, in seconds");
  else bad("expiresIn is the access lifetime in seconds", String(phone.expiresIn));

  const sessionDays = (new Date(phone.sessionExpiresAt) - Date.now()) / DAY;
  if (Math.abs(sessionDays - 90) < 0.01) ok("the session expires in 90 days");
  else bad("sessionExpiresAt is 90 days out", `${sessionDays.toFixed(2)} days`);

  let r = await row();
  if (r.sessions?.length === 1 && r.sessions[0]._id === claims.sid) {
    ok("one session on the GuardianAccess row, matching the token's sid");
  } else {
    bad("the row holds the session", JSON.stringify(r.sessions));
  }
  if (r.sessions?.[0]?.tokenHash === sha256(phone.refreshToken)) {
    ok("the row stores the SHA-256 of the refresh token");
  } else {
    bad("tokenHash is sha256(refreshToken)", r.sessions?.[0]?.tokenHash);
  }
  if (!JSON.stringify(r).includes(phone.refreshToken)) ok("and the token itself appears nowhere on the row");
  else bad("the refresh token is not stored in the clear");

  let res = await me(phone.token);
  if (isOk(res) && res.body.data?.student?._id === "st-1") ok("GET /me with the access token → 200, the right child");
  else bad("the access token opens the portal", `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- twenty minutes pass; nobody types anything ---");
  const lapsed = jwt.sign(
    { aud: "portal", accessId, schoolId: S, sid: claims.sid, exp: Math.floor(Date.now() / 1000) - 60 },
    process.env.JWT_SECRET
  );
  res = await me(lapsed);
  if (refused(res, "TOKEN_EXPIRED")) ok("an expired access token → 401 TOKEN_EXPIRED, which is what the client renews on");
  else bad("expired access token is TOKEN_EXPIRED", `${res.status} ${res.body?.code}`);

  let ref = await renew(phone.refreshToken);
  if (isOk(ref) && ref.body.token) ok("POST /refresh with the refresh token → a new access token");
  else bad("refresh issues a token", `${ref.status} ${JSON.stringify(ref.body)}`);
  if (!("refreshToken" in ref.body)) ok("and no new refresh token — the session token is not rotated");
  else bad("refresh does not rotate the session token");

  res = await me(ref.body.token);
  if (isOk(res)) ok("the renewed access token is accepted");
  else bad("renewed token works", `${res.status} ${res.body?.code}`);

  r = await row();
  if (r.sessions.length === 1) ok("still one session — a renewal is not a sign-in");
  else bad("renewal does not add a session", String(r.sessions.length));
  if (r.lastSeenAt && Date.now() - new Date(r.lastSeenAt) < 10_000) ok("lastSeenAt moved, so the office sees the code is in use");
  else bad("lastSeenAt is updated by a renewal", String(r.lastSeenAt));

  ref = await renew(phone.refreshToken);
  if (isOk(ref)) ok("the same refresh token renews again — it lasts the session");
  else bad("a refresh token is reusable", `${ref.status} ${ref.body?.code}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- offline for a month ---");
  await GuardianAccess.updateOne(
    { _id: accessId, "sessions._id": claims.sid },
    { $set: { "sessions.$.lastUsedAt": new Date(Date.now() - 30 * DAY) } }
  );
  ref = await renew(phone.refreshToken);
  if (isOk(ref)) ok("a session unused for 30 days still renews — being offline is not a sign-out");
  else bad("30 days idle still renews", `${ref.status} ${ref.body?.code}`);

  await GuardianAccess.updateOne(
    { _id: accessId, "sessions._id": claims.sid },
    { $set: { "sessions.$.expiresAt": new Date(Date.now() - DAY) } }
  );
  ref = await renew(phone.refreshToken);
  if (refused(ref, "SESSION_EXPIRED")) ok("past the 90 days → 401 SESSION_EXPIRED");
  else bad("an expired session is refused", `${ref.status} ${ref.body?.code}`);
  r = await row();
  if (r.sessions.length === 0) ok("and the dead session is removed from the row");
  else bad("expired session is pruned", String(r.sessions.length));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- tokens that are not a session ---");
  for (const [label, bogus] of [
    ["no token",         undefined],
    ["an empty string",  ""],
    ["a made-up string", "not-a-token"],
    ["a random token",   crypto.randomBytes(32).toString("base64url")],
    ["the dead one",     phone.refreshToken],
  ]) {
    ref = await renew(bogus);
    if (refused(ref, "SESSION_EXPIRED")) ok(`${label} → 401 SESSION_EXPIRED`);
    else bad(`${label} is refused`, `${ref.status} ${ref.body?.code}`);
  }
  res = await me(phone.refreshToken);
  if (refused(res, "INVALID_TOKEN")) ok("a refresh token used as a Bearer token → 401 INVALID_TOKEN");
  else bad("refresh token is not an access token", `${res.status} ${res.body?.code}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- two phones, one code ---");
  const a = (await signIn()).body;
  const b = (await signIn()).body;
  r = await row();
  if (r.sessions.length === 2) ok("two sign-ins, two sessions");
  else bad("each device gets its own session", String(r.sessions.length));
  if (isOk(await renew(a.refreshToken)) && isOk(await renew(b.refreshToken))) ok("both renew");
  else bad("both sessions renew");

  console.log("\n--- sign out on one of them ---");
  let out = await call("POST", "/logout", { body: { refreshToken: a.refreshToken } });
  if (isOk(out) && out.body.ended === true) ok("POST /logout → 200, ended");
  else bad("logout succeeds", `${out.status} ${JSON.stringify(out.body)}`);
  if (refused(await renew(a.refreshToken), "SESSION_EXPIRED")) ok("that phone can no longer renew");
  else bad("logout ends the session");
  if (isOk(await renew(b.refreshToken))) ok("the other phone is unaffected");
  else bad("logout is per device");
  out = await call("POST", "/logout", { body: { refreshToken: a.refreshToken } });
  if (isOk(out) && out.body.ended === false) ok("signing out twice is quiet");
  else bad("logout is idempotent", `${out.status} ${JSON.stringify(out.body)}`);
  out = await call("POST", "/logout", { body: {} });
  if (isOk(out)) ok("and so is signing out with nothing to sign out of");
  else bad("logout without a token is not an error", String(out.status));
  r = await row();
  if (r.sessions.length === 1) ok("one session left on the row");
  else bad("logout removed exactly one session", String(r.sessions.length));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- a family that signs in on many phones ---");
  const many = [];
  for (let i = 0; i < portal.MAX_SESSIONS + 2; i++) {
    many.push((await signIn()).body);
    // Distinct lastUsedAt, so "least recently used" is well defined.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  r = await row();
  if (r.sessions.length === portal.MAX_SESSIONS) ok(`the row never holds more than ${portal.MAX_SESSIONS} sessions`);
  else bad("sessions are capped", String(r.sessions.length));
  if (isOk(await renew(many[many.length - 1].refreshToken))) ok("the newest sign-in works");
  else bad("the newest session survives the cap");
  if (refused(await renew(b.refreshToken), "SESSION_EXPIRED")) ok("the least recently used one was the one dropped");
  else bad("the oldest session is dropped first");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the office re-issues the code (the slip was lost) ---");
  const keep = many[many.length - 1];
  const reissued = await portal.issueAccess({ schoolId: S, accessId });
  r = await row();
  if (r.sessions.length === 0) ok("every session opened with the old code ends");
  else bad("re-issue clears the sessions", String(r.sessions.length));
  if (refused(await renew(keep.refreshToken), "SESSION_EXPIRED")) ok("an old refresh token → 401 SESSION_EXPIRED");
  else bad("old sessions cannot renew after re-issue");
  res = await me(keep.token);
  note(`an access token minted before the re-issue answers ${res.status} for its remaining minutes;`);
  note(`the bound on that is the ${portal.ACCESS_TOKEN_MINUTES}-minute lifetime, which is why it is short.`);
  if (refused(await signIn(), "INVALID_CREDENTIALS")) ok("the old code no longer signs in");
  else bad("the old code is dead");
  code = reissued.code;
  const c = (await signIn()).body;
  if (c.token && c.refreshToken) ok("the new code signs in and starts a fresh session");
  else bad("the new code works", JSON.stringify(c));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the office revokes the code ---");
  await portal.revokeAccess({ schoolId: S, accessId });
  res = await me(c.token);
  if (refused(res, "ACCESS_REVOKED")) ok("a live access token is refused on the very next request — not in twenty minutes");
  else bad("revocation is immediate", `${res.status} ${res.body?.code}`);
  ref = await renew(c.refreshToken);
  if (refused(ref, "ACCESS_REVOKED")) ok("and the session cannot renew: 401 ACCESS_REVOKED, told apart from an expiry");
  else bad("refresh refuses a revoked code", `${ref.status} ${ref.body?.code}`);
  r = await row();
  if (r.sessions.length === 1 && !r.codeHash) {
    ok("the session stays on the row, dead - no code hash to be alive against - so the answer above can be specific");
  } else {
    bad("a revoked row keeps its dead sessions", `${r.sessions.length} session(s), codeHash=${r.codeHash}`);
  }
  if (refused(await signIn(), "INVALID_CREDENTIALS")) ok("the code itself no longer signs in");
  else bad("a revoked code is dead");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the controls around the code are as they were ---");
  const staff = jwt.sign({ id: "usr-1", role: "teacher", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  if (refused(await me(staff), "INVALID_TOKEN")) ok("a staff token is still refused by the portal (audience check)");
  else bad("a staff token does not open the portal");

  code = (await portal.issueAccess({ schoolId: S, accessId })).code;
  for (let i = 0; i < portal.MAX_TRIES; i++) {
    await call("POST", "/login", { body: { admissionNo: "ADM-001", code: "AAAA-AAAA" } });
  }
  const locked = await signIn();
  if (locked.status === 429 && locked.body.code === "LOCKED") {
    ok(`${portal.MAX_TRIES} wrong codes still lock the access — the right code is refused with 429`);
  } else {
    bad("the lockout is intact", `${locked.status} ${locked.body?.code}`);
  }
  r = await row();
  if (r.sessions.length === 0) ok("and no failed attempt ever started a session");
  else bad("failed sign-ins create no sessions", String(r.sessions.length));

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
