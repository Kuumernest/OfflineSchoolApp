// backend/scripts/check-email-transport.js
"use strict";

/**
 * Assert that both send paths agree about how email leaves the building.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * There were two answers and they disagreed. email.service.js understood
 * SendGrid, Gmail and a generic SMTP host; notification/channels.js understood
 * Gmail alone and reported isConfigured() false for anything else. Since
 * resolveChannel() consults that answer and its fallback chain ends at the log
 * channel — which always succeeds — a school on SendGrid received staff
 * credentials while every fee reminder was printed to stdout and reported as
 * sent.
 *
 * The two paths now share email.transport.js. Nothing stops them drifting apart
 * again except this file, so the assertions are deliberately about AGREEMENT
 * rather than about either one's behaviour alone.
 *
 * Pure: no database, no network, no sockets opened. Provider selection is a
 * decision about environment variables and is tested as one.
 *
 *   node scripts/check-email-transport.js
 */

const mail     = require("../src/services/email.transport");
const channels = require("../src/services/notification/channels");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

// Every provider var, so a real .env in the developer's shell cannot make this
// suite pass or fail for the wrong reason.
const ALL = [
  "SENDGRID_API_KEY",
  "BREVO_SMTP_USER", "BREVO_SMTP_KEY",
  "GMAIL_USER", "GMAIL_APP_PASSWORD",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE",
  "EMAIL_FROM",
];

/** A fresh environment containing only what a case names. */
const env = (vars = {}) => {
  const e = {};
  for (const k of ALL) if (vars[k] !== undefined) e[k] = vars[k];
  return e;
};

const SENDGRID = { SENDGRID_API_KEY: "SG.aaaaaaaa.bbbbbbbb", EMAIL_FROM: "office@school.com" };
const BREVO    = { BREVO_SMTP_USER: "8a1b2c001@smtp-brevo.com", BREVO_SMTP_KEY: "xsmtpsib-key", EMAIL_FROM: "office@school.com" };
const GMAIL    = { GMAIL_USER: "school@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };
const SMTP     = { SMTP_HOST: "mail.host.com", SMTP_USER: "u", SMTP_PASS: "p", EMAIL_FROM: "office@school.com" };

console.log("--- each provider is recognised from its own variables ---");

check("nothing configured is nothing",        mail.provider(env())?.name ?? null, null);
check("SendGrid",                             mail.provider(env(SENDGRID)).name, "sendgrid");
check("Brevo",                                mail.provider(env(BREVO)).name,    "brevo");
check("Gmail",                                mail.provider(env(GMAIL)).name,    "gmail");
check("a generic SMTP host",                  mail.provider(env(SMTP)).name,     "smtp");

console.log("--- a dedicated provider wins over a Gmail left in place ---");

// Migrating off a personal Gmail should be lines ADDED to .env. A half-finished
// edit that leaves both present has to land on the one the school is moving TO.
check("SendGrid over Gmail", mail.provider(env({ ...GMAIL, ...SENDGRID })).name, "sendgrid");
check("Brevo over Gmail",    mail.provider(env({ ...GMAIL, ...BREVO    })).name, "brevo");
check("and Gmail over a bare SMTP host",
  mail.provider(env({ ...GMAIL, ...SMTP })).name, "gmail");

console.log("--- half-set variables do not count as configured ---");

// The failure this prevents: a provider selected on one variable, then an
// authentication attempt with an undefined password, reported as a credential
// problem rather than a missing one.
check("an SMTP host with no user",     mail.isConfigured(env({ SMTP_HOST: "mail.host.com" })), false);
check("a Gmail user with no password", mail.isConfigured(env({ GMAIL_USER: "a@gmail.com" })),  false);
check("a Brevo user with no key",      mail.isConfigured(env({ BREVO_SMTP_USER: "x" })),       false);

console.log("--- the sender address ---");

check("Gmail sends as itself, no EMAIL_FROM needed",
  mail.fromAddress(env(GMAIL)), "school@gmail.com");
check("and Gmail is ready without one", mail.problems(env(GMAIL)), []);

// The old fallback chain ended at noreply@schoolapp.com — a domain this project
// does not own, which SendGrid and Brevo reject and any receiving server may
// treat as forged.
check("SendGrid without EMAIL_FROM has no sender to invent",
  mail.fromAddress(env({ SENDGRID_API_KEY: "SG.x.y" })), null);
check("and says so rather than trying",
  mail.problems(env({ SENDGRID_API_KEY: "SG.x.y" })).length, 1);
check("naming the variable to set",
  /EMAIL_FROM/.test(mail.problems(env({ SENDGRID_API_KEY: "SG.x.y" }))[0]), true);
check("Brevo the same",
  mail.problems(env({ BREVO_SMTP_USER: "x", BREVO_SMTP_KEY: "y" })).length, 1);
check("EMAIL_FROM overrides even for Gmail",
  mail.fromAddress(env({ ...GMAIL, EMAIL_FROM: "office@school.com" })), "office@school.com");

console.log("--- credentials are cleaned the same way for every provider ---");

for (const [label, vars, path] of [
  ["Gmail",    GMAIL,    ["auth", "pass"]],
  ["SendGrid", SENDGRID, ["auth", "pass"]],
  ["Brevo",    BREVO,    ["auth", "pass"]],
]) {
  const spaced = { ...vars };
  // A pasted key can pick up a trailing newline as easily as Google's app
  // password arrives in four spaced groups.
  for (const k of Object.keys(spaced)) {
    if (k !== "EMAIL_FROM") spaced[k] = ` ${spaced[k]} \n`;
  }
  const built = mail.provider(env(spaced)).build(env(spaced));
  const value = path.reduce((o, k) => o?.[k], built);
  check(`${label}: no whitespace survives into the credential`,
    /\s/.test(String(value)), false);
}

check("SendGrid's username is the literal 'apikey', not the key",
  mail.provider(env(SENDGRID)).build(env(SENDGRID)).auth.user, "apikey");

console.log("--- no provider means a refusal, not a doomed connection ---");

// It used to default to smtp.mailtrap.io, so an unconfigured deployment
// authenticated against a third party and failed with a message about
// credentials rather than about configuration.
let threw = null;
try { mail.transport(env()); } catch (err) { threw = err; }
check("transport() throws", Boolean(threw), true);
check("with the code the dispatcher records a SKIP for, not a retry",
  threw?.code, "CHANNEL_NOT_CONFIGURED");
check("and a message naming what to set",
  /SENDGRID_API_KEY|BREVO_SMTP_USER|GMAIL_USER|SMTP_HOST/.test(threw?.message ?? ""), true);

const hosts = Object.fromEntries(
  mail.PROVIDERS.map((p) => [p.name, p.build(env({ ...SENDGRID, ...BREVO, ...GMAIL, ...SMTP })).host])
);
check("and no provider points at a host nobody configured",
  hosts, {
    sendgrid: "smtp.sendgrid.net",
    brevo:    "smtp-relay.brevo.com",
    gmail:    "smtp.gmail.com",
    smtp:     "mail.host.com",
  });

console.log("--- and the notification queue asks the same question ---");

// THE BUG THIS SUITE EXISTS FOR. resolveChannel() consults
// emailChannel.isConfigured() and falls back to the log channel, which always
// succeeds — so a disagreement here is not a warning anybody sees. It is fee
// reminders going to stdout and being reported as sent.
const emailChannel = channels.getChannel
  ? channels.getChannel("email")
  : channels.channels?.email;
check("the email channel is reachable from the dispatcher", Boolean(emailChannel), true);

const saved = {};
for (const k of ALL) { saved[k] = process.env[k]; delete process.env[k]; }
try {
  check("both agree: nothing configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [false, false]);

  Object.assign(process.env, SENDGRID);
  check("both agree: SendGrid is configured — the case that used to disagree",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);

  for (const k of Object.keys(SENDGRID)) delete process.env[k];
  Object.assign(process.env, BREVO);
  check("both agree: Brevo is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);

  for (const k of Object.keys(BREVO)) delete process.env[k];
  Object.assign(process.env, GMAIL);
  check("both agree: Gmail is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);
} finally {
  for (const k of ALL) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  mail.reset();
}

console.log("--- describe() is safe to paste into a support thread ---");

const shown = JSON.stringify(mail.describe(env(GMAIL)));
check("the app password does not appear in it",
  shown.includes("abcd efgh ijkl mnop") || shown.includes("abcdefghijklmnop"), false);
check("but its shape does",
  /16 chars|19 chars/.test(shown), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
