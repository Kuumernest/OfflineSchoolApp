// backend/scripts/check-temp-password-lifecycle.js
"use strict";

/**
 * A temporary password is a way in to choose a real one, and nothing else.
 *
 * The lifecycle, in one place (docs/22-release-readiness.md, X21):
 *
 *   temporary password → sign in → a fifteen-minute token, no refresh token,
 *   RESTRICTED to change-password / own profile / logout → every other route
 *   answers 403 PASSWORD_CHANGE_REQUIRED, refresh in either mode included →
 *   the password is changed (the old one refused, the policy applied) → an
 *   ordinary token and a refresh token → the temporary token is dead → the
 *   ordinary refresh lifecycle.
 *
 * What used to be true: the fifteen-minute token opened every protected route
 * for fifteen minutes, and the access-token refresh mode minted another
 * fifteen on request, indefinitely.
 *
 *   node scripts/check-temp-password-lifecycle.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret-long-enough";
  process.env.NODE_ENV           = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School = mongoose.model("School");
  const User   = mongoose.model("User");
  const Class  = mongoose.model("Class");
  const Student = mongoose.model("Student");

  const A = "68c0000000000000000000a1";
  await School.create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });
  const TEMP   = "Temp-Passw0rd";
  const CHOSEN = "Chosen-Passw0rd-42";
  const NORMAL = "Normal-Passw0rd";
  const mk = (id, role, extra = {}) => User.create({
    _id: id, name: id, email: `${id}@example.test`, role, schoolId: A, isActive: true, ...extra,
  });
  await Promise.all([
    mk("temp-bursar",  "bursar",       { password: TEMP,   mustResetPassword: true }),
    mk("temp-teacher", "teacher",      { password: TEMP,   mustResetPassword: true }),
    mk("temp-pupil",   "student",      { password: TEMP,   mustResetPassword: true, enrollmentNo: "A-0007" }),
    mk("settled",      "teacher",      { password: NORMAL }),
    mk("admin-a",      "school_admin", { password: NORMAL }),
  ]);
  await Class.create({ _id: "form3a", schoolId: A, name: "Form 3A" });
  await Student.create({ _id: "st-7", userId: "temp-pupil", schoolId: A, classId: "form3a", studentName: "Pupil Seven", enrollmentNo: "A-0007", isActive: true, status: "approved" });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",          require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/users",         auth.authenticate, require(path.join(SRC, "routes/user.routes")));
  app.use("/api/announcements", auth.authenticate, require(path.join(SRC, "routes/announcement.routes")));
  app.use("/api/attendance",    auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  app.use("/api/student",       auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const login   = (body) => call("POST", "/auth/login", { body });
  const life    = (token) => { const { iat, exp } = jwt.decode(token); return exp - iat; };
  const denied  = (r) => [r.status, r.body?.code ?? null];
  const RESTRICTED = [403, "PASSWORD_CHANGE_REQUIRED"];

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- signing in with a temporary password ---");
  let r = await login({ email: "temp-bursar@example.test", password: TEMP });
  check("→ 200, the flag on the user", [r.status, r.body?.user?.mustResetPassword], [200, true]);
  const tempToken = r.body?.token;
  check("  a fifteen-minute token", life(tempToken), 15 * 60);
  check("  and no refresh token", "refreshToken" in r.body, false);
  check("  the token carries id, role and school — no secret, no password", Object.keys(jwt.decode(tempToken)).sort(), ["exp", "iat", "id", "role", "schoolId"]);

  console.log("\n--- the restricted state: three doors, no others ---");
  r = await call("GET", "/auth/me", { token: tempToken });
  check("own profile → 200", [r.status, r.body?.user?.mustResetPassword], [200, true]);
  r = await call("GET", "/users/me", { token: tempToken });
  check("own profile, the other spelling → 200", r.status, 200);
  r = await call("GET", "/attendance/students/today?classId=form3a", { token: tempToken });
  check("a protected read → 403 PASSWORD_CHANGE_REQUIRED", denied(r), RESTRICTED);
  r = await call("POST", "/attendance/students/bulk", { token: tempToken, body: { classId: "form3a", date: "2026-09-17", records: [] } });
  check("a protected write → 403", denied(r), RESTRICTED);
  r = await call("GET", "/attendance/students/today?classId=form3a&x=1", { token: tempToken });
  check("  the query string does not change the answer", denied(r), RESTRICTED);
  r = await call("POST", "/auth/me", { token: tempToken });
  check("  nor does the method: POST to the profile route is not a door", r.status === 200, false);

  console.log("\n--- refresh does not renew a temporary password ---");
  r = await call("POST", "/auth/refresh", { token: tempToken, body: {} });
  check("access-token mode with the temporary token → 403, no token minted", [...denied(r), "token" in r.body], [...RESTRICTED, false]);
  const forged = jwt.sign({ id: "temp-bursar" }, process.env.JWT_REFRESH_SECRET, { expiresIn: "1h" });
  r = await call("POST", "/auth/refresh", { body: { refreshToken: forged } });
  check("refresh-token mode for a flagged account → 403, no token minted", [...denied(r), "token" in r.body], [...RESTRICTED, false]);

  console.log("\n--- a refresh token from before an administrator's reset ---");
  r = await login({ email: "settled@example.test", password: NORMAL });
  const oldRefresh = r.body?.refreshToken;
  check("an ordinary account signs in with a refresh token", typeof oldRefresh, "string");
  await new Promise((res) => setTimeout(res, 6500));           // past the 5 s leeway around passwordChangedAt
  const settled = await User.findById("settled").select("+password");
  settled.password = TEMP; settled.mustResetPassword = true;   // what an admin reset does
  await settled.save();
  r = await call("POST", "/auth/refresh", { body: { refreshToken: oldRefresh } });
  check("the old refresh token is dead: 401 REFRESH_STALE", denied(r), [401, "REFRESH_STALE"]);
  check("  no token minted", "token" in r.body, false);

  console.log("\n--- changing the password: refusals leave the state as it was ---");
  const change = (token, body) => call("POST", "/auth/change-password", { token, body });
  r = await change(tempToken, { newPassword: CHOSEN, confirmPassword: "Other-Passw0rd-1" });
  check("mismatched confirmation → 400", r.status, 400);
  r = await change(tempToken, { newPassword: "short", confirmPassword: "short" });
  check("a password outside the policy → 400", r.status, 400);
  r = await change(tempToken, { newPassword: TEMP, confirmPassword: TEMP });
  check("the temporary password itself → 400", r.status, 400);
  check("  the flag still set", (await User.findById("temp-bursar").lean()).mustResetPassword, true);
  r = await call("GET", "/attendance/students/today?classId=form3a", { token: tempToken });
  check("  and the account still restricted", denied(r), RESTRICTED);

  console.log("\n--- changing the password: success ends the restriction ---");
  r = await change(tempToken, { newPassword: CHOSEN, confirmPassword: CHOSEN });
  check("accepted without the current password (the person may never have typed it)", r.status, 200);
  const newToken = r.body?.token, newRefresh = r.body?.refreshToken;
  check("  an ordinary thirty-day token and a refresh token come back", [life(newToken), typeof newRefresh, r.body?.user?.mustResetPassword], [30 * 24 * 3600, "string", false]);
  r = await call("GET", "/attendance/students/today?classId=form3a", { token: newToken });
  check("the protected read now → 200", r.status, 200);
  r = await call("GET", "/attendance/students/today?classId=form3a", { token: tempToken });
  check("the temporary token is dead: 401 TOKEN_STALE", denied(r), [401, "TOKEN_STALE"]);
  r = await call("POST", "/auth/refresh", { body: { refreshToken: newRefresh } });
  check("refresh-token mode → 200, a new session", [r.status, typeof r.body?.token], [200, "string"]);
  r = await call("POST", "/auth/refresh", { token: newToken, body: {} });
  check("access-token mode → 200 too", r.status, 200);
  r = await login({ email: "temp-bursar@example.test", password: TEMP });
  check("the temporary password no longer signs in", r.status, 401);
  r = await login({ email: "temp-bursar@example.test", password: CHOSEN });
  check("the chosen one does, with a refresh token", [r.status, typeof r.body?.refreshToken], [200, "string"]);

  console.log("\n--- an expired temporary token ---");
  const expired = jwt.sign({ id: "temp-teacher", role: "teacher", schoolId: A }, process.env.JWT_SECRET, { expiresIn: -60 });
  r = await call("GET", "/auth/me", { token: expired });
  check("→ 401 TOKEN_EXPIRED even on the profile door", denied(r), [401, "TOKEN_EXPIRED"]);
  r = await login({ email: "temp-teacher@example.test", password: TEMP });
  check("signing in again with the temporary password restarts the fifteen minutes", [r.status, life(r.body?.token)], [200, 15 * 60]);
  const teacherTemp = r.body?.token;

  console.log("\n--- a teacher's temporary token cannot reach the register ---");
  r = await call("POST", "/attendance/students/bulk", { token: teacherTemp, body: { classId: "form3a", date: "2026-09-17", records: [{ studentId: "st-7", status: "present" }] } });
  check("the register write → 403 PASSWORD_CHANGE_REQUIRED, before any class or assignment check", denied(r), RESTRICTED);

  console.log("\n--- logout ---");
  r = await call("POST", "/auth/logout", { token: teacherTemp });
  check("→ 200", r.status, 200);
  r = await call("GET", "/auth/me", { token: teacherTemp });
  check("logout is stateless: the token stays valid until its fifteen minutes end (known limitation, recorded)", r.status, 200);

  console.log("\n--- a pupil on a temporary password ---");
  r = await login({ enrollmentNo: "A-0007", password: TEMP });
  const pupilTemp = r.body?.token;
  check("signs in by enrolment number: fifteen minutes, no refresh token", [r.status, life(pupilTemp), "refreshToken" in r.body], [200, 15 * 60, false]);
  r = await call("GET", "/student/me", { token: pupilTemp });
  check("their own record → 403 until the password is chosen", denied(r), RESTRICTED);
  r = await change(pupilTemp, { newPassword: CHOSEN, confirmPassword: CHOSEN });
  check("the change → 200 with an ordinary token", [r.status, life(r.body?.token)], [200, 30 * 24 * 3600]);
  r = await call("GET", "/student/me", { token: r.body?.token });
  check("  and the record opens", r.status, 200);

  console.log("\n--- an account that was never flagged is untouched ---");
  r = await login({ email: "admin-a@example.test", password: NORMAL });
  check("ordinary sign-in: thirty days and a refresh token", [life(r.body?.token), typeof r.body?.refreshToken], [30 * 24 * 3600, "string"]);
  r = await call("GET", "/announcements", { token: r.body?.token });
  check("  protected reads open", r.status, 200);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
