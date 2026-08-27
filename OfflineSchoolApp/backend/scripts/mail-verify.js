// backend/scripts/mail-verify.js
"use strict";

/**
 * Say whether this deployment can send email, and if not, why.
 *
 *   npm run mail:verify
 *
 * ── Why this is a script and not a startup check ───────────────────────────
 *
 * Because it opens a connection and authenticates, and a server must not do
 * that on boot: a mail provider having a bad afternoon would stop the school
 * from taking a fee payment. It is a question you ask deliberately, after
 * editing .env, and the answer has to be unambiguous — the failure it exists to
 * diagnose (535 "Username and Password not accepted") is worded identically for
 * a revoked key, a mistyped one, a key belonging to a different account, and
 * two-factor authentication having been switched off.
 *
 * ── What it never does ────────────────────────────────────────────────────
 *
 * Print a credential. It reports LENGTH and whether the value contains
 * whitespace, because those are what actually go wrong with a pasted secret,
 * and a short fingerprint so that "did my edit land?" can be answered without
 * anybody reading the value aloud. It also sends nothing: verify() completes
 * the SMTP handshake and authenticates, then disconnects.
 *
 * Pass an address to send a real test message instead:
 *
 *   node scripts/mail-verify.js you@example.com
 */

require("dotenv").config();

const crypto = require("crypto");
const mail   = require("../src/services/email.transport");

/** Enough to compare two edits, far too little to recover the value. */
const fingerprint = (v) =>
  crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 8);

const main = async () => {
  const target = process.argv[2] ?? null;
  const info   = mail.describe();

  console.log("");
  console.log("  Email configuration");
  console.log("  ───────────────────");
  console.log(`  provider   : ${info.label}${info.provider ? ` (${info.provider})` : ""}`);
  console.log(`  from        : ${info.from ?? "— not set —"}`);

  for (const [key, shape] of Object.entries(info.vars)) {
    const raw = process.env[key];
    const fp  = raw ? `  fp ${fingerprint(String(raw).replace(/\s+/g, ""))}` : "";
    console.log(`  ${key.padEnd(20)}: ${shape}${fp}`);
  }

  if (info.problems.length) {
    console.log("");
    console.log("  Not ready:");
    info.problems.forEach((p) => console.log(`    • ${p}`));
    console.log("");
    console.log("  Nothing this app sends will be delivered until that is fixed —");
    console.log("  not staff credentials, and not fee reminders.");
    console.log("");
    process.exit(1);
  }

  // ── Authenticate ────────────────────────────────────────────────────────
  console.log("");
  process.stdout.write("  authenticating (nothing is sent) ... ");

  let transport;
  try {
    transport = mail.transport();
    await transport.verify();
    console.log("accepted ✓");
  } catch (err) {
    console.log("REFUSED");
    console.log("");
    console.log(`    ${err.code ?? "ERR"}: ${String(err.message).split("\n")[0]}`);
    console.log("");

    // 535 is the one worth explaining, because the wording covers four
    // different mistakes and names none of them.
    if (/\b535\b/.test(String(err.message))) {
      console.log("  535 means the server understood the request and rejected the");
      console.log("  credential. It does NOT distinguish between:");
      console.log("");
      if (info.provider === "gmail") {
        console.log("    • 2-Step Verification switched off on that Google account —");
        console.log("      which silently invalidates every app password it ever issued.");
        console.log("      Check: myaccount.google.com/apppasswords. If that page will");
        console.log("      not load, this is your answer.");
        console.log("    • an app password generated on a DIFFERENT Google account than");
        console.log("      GMAIL_USER — easy to do with two accounts in one browser.");
        console.log("    • a revoked or mistyped password.");
      } else {
        console.log("    • a revoked or regenerated key.");
        console.log("    • a key from a different account than the one being used.");
        console.log("    • a key pasted with a character missing or added.");
      }
      console.log("");
    }
    process.exit(1);
  }

  // ── Optionally send one ─────────────────────────────────────────────────
  if (!target) {
    console.log("");
    console.log("  Ready. Pass an address to send a real test message:");
    console.log("    node scripts/mail-verify.js you@example.com");
    console.log("");
    process.exit(0);
  }

  process.stdout.write(`  sending a test message to ${target} ... `);
  try {
    const sent = await transport.sendMail({
      from:    `"${process.env.SCHOOL_NAME || "School App"}" <${info.from}>`,
      to:      target,
      subject: "Test message from your school app",
      text:
        "This is a test from scripts/mail-verify.js.\n\n" +
        `Provider: ${info.label}\nFrom: ${info.from}\n\n` +
        "If you are reading this, staff credentials and fee reminders will " +
        "reach families.",
    });
    console.log(`sent ✓  (id ${sent.messageId})`);
    console.log("");
    console.log("  Check the inbox AND the spam folder. Landing in spam is a");
    console.log("  deliverability problem, not a configuration one, and it is the");
    console.log("  next thing to fix if it happens — bulk fee reminders from an");
    console.log("  unauthenticated domain are treated harshly.");
    console.log("");
  } catch (err) {
    console.log("FAILED");
    console.log(`    ${err.code ?? "ERR"}: ${String(err.message).split("\n")[0]}`);
    if (err.response) console.log(`    server said: ${err.response}`);
    console.log("");
    // Authentication passed and the send did not, so this is almost always the
    // sender address rather than the credential.
    console.log("  Authentication succeeded, so the credential is fine. A failure");
    console.log("  here is usually EMAIL_FROM not being verified in the provider's");
    console.log("  account — verify that exact address, or a domain that covers it.");
    console.log("");
    process.exit(1);
  }

  process.exit(0);
};

main().catch((err) => {
  console.error("\n  Harness error:", err);
  process.exit(1);
});
