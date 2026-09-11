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
  console.log(`  provider    : ${info.label}${info.provider ? ` (${info.provider})` : ""}`);
  console.log(`  from        : ${info.from ?? "— not set —"}`);
  if (info.replyTo) console.log(`  reply-to    : ${info.replyTo}`);
  console.log(
    info.failover
      ? `  failover    : ${info.failover.label} as ${info.failover.as ?? "(unknown)"}`
      : "  failover    : none — a refused send is reported, not retried"
  );

  for (const [key, shape] of Object.entries(info.vars)) {
    const raw = process.env[key];
    const fp  = raw ? `  fp ${fingerprint(String(raw).replace(/\s+/g, ""))}` : "";
    console.log(`  ${key.padEnd(20)}: ${shape}${fp}`);
  }

  // Set, but worth a word. Nothing here stops a send.
  for (const note of info.advisories ?? []) console.log(`  note        : ${note}`);

  /*
   * Which Brevo templates this deployment will use, and which fall back to the
   * HTML this app renders itself. Unset is a working state, not a fault — the
   * point of printing it is that "did the wording change?" is otherwise
   * unanswerable, because an absent id looks exactly like a wrong one.
   */
  if (info.templates && Object.keys(info.templates).length) {
    const assigned = Object.entries(info.templates).filter(([, id]) => id);
    const unset    = Object.entries(info.templates).filter(([, id]) => !id).map(([k]) => k);
    console.log("");
    console.log("  Brevo templates");
    for (const [purpose, id] of assigned) console.log(`    ${purpose.padEnd(16)}: #${id}`);
    if (unset.length) {
      console.log(`    not assigned    : ${unset.join(", ")}`);
      console.log("    (those send this app's own HTML, which is a supported state)");
    }
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
    /*
     * Every provider in the registry answers this, but not identically: the
     * SMTP entries get nodemailer's verify(), which completes a handshake, and
     * the Brevo API entry has its own, which authenticates against
     * GET /v3/account. A provider that somehow lacks one is reported as
     * unverifiable rather than as accepted — this script exists to answer
     * "will mail actually leave", and a silent skip is the one answer it must
     * never give.
     */
    if (typeof transport.verify !== "function") {
      console.log("NOT VERIFIABLE");
      console.log("");
      console.log("  This provider offers no way to check a credential without");
      console.log("  sending. Pass an address to send a real test message.");
      console.log("");
      process.exit(1);
    }
    const account = await transport.verify();
    console.log("accepted ✓");
    // Which account the key belongs to. The mistake this catches is a valid
    // key for the wrong Brevo account, which a bare "accepted" would hide.
    if (account && typeof account === "object" && account.account) {
      console.log(`  account     : ${account.account}${account.company ? ` (${account.company})` : ""}`);
      if (account.plan) console.log(`  plan        : ${account.plan}`);
    }
  } catch (err) {
    console.log("REFUSED");
    console.log("");
    console.log(`    ${err.code ?? "ERR"}: ${String(err.message).split("\n")[0]}`);
    console.log("");

    /*
     * Brevo's API answers 401 for any credential it will not accept, and the
     * body reads "Key not found" whether the key was revoked, regenerated,
     * mistyped, or belongs to a different account. The same problem as SMTP's
     * 535 below: one message, four causes, none of them named.
     */
    if (/401|unauthorized|Key not found/i.test(String(err.message))) {
      console.log("  Brevo rejected the API key. That one answer covers:");
      console.log("");
      console.log("    • a key that was regenerated in the panel — generating a new");
      console.log("      one does NOT keep the old one working.");
      console.log("    • a key from a different Brevo account than the one the");
      console.log("      sending domain is authenticated in.");
      console.log("    • a key pasted with a character missing, or truncated by a");
      console.log("      shell that treated part of it as a comment.");
      console.log("    • an SMTP key (xsmtpsib-…) in BREVO_API_KEY, which needs a v3");
      console.log("      API key (xkeysib-…). Two different credentials, issued from");
      console.log("      the same panel page.");
      console.log("");
      console.log("  The variable shapes above are the quickest check: a v3 key runs");
      console.log("  to roughly 60-80 characters and contains no whitespace.");
      console.log("");
    }

    // 535 is the SMTP equivalent, for the relay and generic-host routes.
    if (/\b535\b/.test(String(err.message))) {
      console.log("  535 means the server understood the request and rejected the");
      console.log("  credential. It does NOT distinguish between:");
      console.log("");
      console.log("    • a revoked or regenerated key.");
      console.log("    • a key from a different account than the one being used.");
      console.log("    • a key pasted with a character missing or added.");
      console.log("    • for the Brevo relay: the SMTP login (something like");
      console.log("      8a1b2c001@smtp-brevo.com) confused with the account's own");
      console.log("      login email. Only the first is a valid BREVO_SMTP_USER.");
      console.log("");
    }
    process.exit(1);
  }

  // ── The failover, checked too ───────────────────────────────────────────
  /*
   * A failover nobody has ever authenticated is not a failover. Google
   * invalidates every app password it ever issued the moment 2-Step
   * Verification is switched off on the account, silently, and the only time
   * anyone would otherwise find out is during a Brevo outage — the one moment
   * it is supposed to help. So it is checked here, deliberately, rather than
   * assumed.
   */
  if (info.failover) {
    process.stdout.write(`  checking the ${info.failover.label} failover ... `);
    try {
      const nodemailer = require("nodemailer");
      const entry = mail.PROVIDERS.find((p) => p.name === info.failover.provider);
      await nodemailer.createTransport(entry.build(process.env)).verify();
      console.log("accepted ✓");
    } catch (err) {
      console.log("REFUSED");
      console.log(`    ${err.code ?? "ERR"}: ${String(err.message).split("\n")[0]}`);
      console.log("");
      console.log("  Mail still sends: the failover only matters when a Brevo send");
      console.log("  fails. But it will not help when it does.");
      if (/\b535\b/.test(String(err.message))) {
        console.log("");
        console.log("  535 on Gmail is usually 2-Step Verification having been switched");
        console.log("  off on that Google account, which invalidates every app password");
        console.log("  it ever issued. Check myaccount.google.com/apppasswords — if that");
        console.log("  page will not load, that is your answer. The other common cause is");
        console.log("  an app password generated on a DIFFERENT account than GMAIL_USER.");
      }
      console.log("");
    }
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
      from:    `"${process.env.BREVO_SENDER_NAME || process.env.SCHOOL_NAME || "School App"}" <${info.from}>`,
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
