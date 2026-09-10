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
 * channel — which always succeeds — a school on a provider that file did not
 * know about received staff credentials while every fee reminder was printed
 * to stdout and reported as sent.
 *
 * The two paths now share email.transport.js. Nothing stops them drifting apart
 * again except this file, so the assertions are deliberately about AGREEMENT
 * rather than about either one's behaviour alone.
 *
 * ── What changed when this app moved to Brevo ─────────────────────────────
 *
 * SendGrid and Gmail were removed from the registry rather than left in place
 * "just in case". This suite now asserts their ABSENCE, which is the more
 * useful assertion: a stale SENDGRID_API_KEY or GMAIL_USER in a deployed
 * environment must not resolve to a provider nobody intends to use, because
 * this registry picks the first match and reports success either way. That is
 * the same class of silent-success bug the file was written for.
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

// Every variable any provider reads, plus the two retired ones, so a real .env
// in the developer's shell cannot make this suite pass or fail for the wrong
// reason.
const ALL = [
  "BREVO_API_KEY", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME", "BREVO_REPLY_TO",
  "BREVO_SMTP_USER", "BREVO_SMTP_KEY",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE",
  "EMAIL_FROM",
  // Retired. Present here so the "these no longer resolve" cases below are
  // testing the registry and not the developer's shell.
  "SENDGRID_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD",
  // Every template variable, read from the adapter rather than listed, so a
  // purpose added there cannot be silently untestable here — env() below drops
  // anything not in this array, which is exactly how the first draft of the
  // template section passed a nonexistent id and read null.
  ...Object.values(require("../src/services/email.brevo").TEMPLATE_VARS),
];

/** A fresh environment containing only what a case names. */
const env = (vars = {}) => {
  const e = {};
  for (const k of ALL) if (vars[k] !== undefined) e[k] = vars[k];
  return e;
};

const API = {
  BREVO_API_KEY:      "xkeysib-0123456789abcdef0123456789abcdef",
  BREVO_SENDER_EMAIL: "no-reply@offlineschool.vgrp.org",
  BREVO_SENDER_NAME:  "OfflineSchoolApp",
  BREVO_REPLY_TO:     "support@vgrp.org",
};
const RELAY    = { BREVO_SMTP_USER: "8a1b2c001@smtp-brevo.com", BREVO_SMTP_KEY: "xsmtpsib-key", EMAIL_FROM: "office@school.com" };
const SMTP     = { SMTP_HOST: "mail.host.com", SMTP_USER: "u", SMTP_PASS: "p", EMAIL_FROM: "office@school.com" };
const SENDGRID = { SENDGRID_API_KEY: "SG.aaaaaaaa.bbbbbbbb", EMAIL_FROM: "office@school.com" };
const GMAIL    = { GMAIL_USER: "school@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };

console.log("--- each provider is recognised from its own variables ---");

check("nothing configured is nothing",   mail.provider(env())?.name ?? null, null);
check("Brevo's transactional API",       mail.provider(env(API)).name,       "brevo-api");
check("Brevo over SMTP",                 mail.provider(env(RELAY)).name,     "brevo-smtp");
check("a generic SMTP host",             mail.provider(env(SMTP)).name,      "smtp");

console.log("--- the retired providers resolve to nothing at all ---");

// THE ASSERTION THAT GUARDS THE REMOVAL. A school that moved to Brevo will
// have a stale key sitting in its environment for a while, and an environment
// that still holds one must be treated as UNCONFIGURED rather than quietly
// routed through a provider the school has stopped paying for — or, worse,
// through a personal Gmail nobody meant to keep using.
check("a stale SendGrid key selects no provider",  mail.provider(env(SENDGRID))?.name ?? null, null);
check("and is reported as not configured",         mail.isConfigured(env(SENDGRID)), false);
check("a leftover Gmail selects no provider",      mail.provider(env(GMAIL))?.name ?? null, null);
check("and is reported as not configured",         mail.isConfigured(env(GMAIL)), false);
check("neither name is in the registry any more",
  mail.PROVIDERS.map((p) => p.name).filter((n) => n === "sendgrid" || n === "gmail"), []);
check("the registry is exactly the three supported routes",
  mail.PROVIDERS.map((p) => p.name), ["brevo-api", "brevo-smtp", "smtp"]);

console.log("--- the API wins over the routes it is migrating from ---");

// Adopting the API should be lines ADDED to .env. A half-finished edit that
// leaves the SMTP variables in place has to land on the one the school is
// moving TO.
check("the API over Brevo's own SMTP relay",
  mail.provider(env({ ...RELAY, ...API })).name, "brevo-api");
check("the API over a generic SMTP host",
  mail.provider(env({ ...SMTP, ...API })).name, "brevo-api");
check("and the relay over a generic SMTP host",
  mail.provider(env({ ...SMTP, ...RELAY })).name, "brevo-smtp");
check("a stale SendGrid key does not displace the API",
  mail.provider(env({ ...SENDGRID, ...API })).name, "brevo-api");

console.log("--- half-set variables do not count as configured ---");

// The failure this prevents: a provider selected on one variable, then an
// authentication attempt with an undefined password, reported as a credential
// problem rather than a missing one.
check("an SMTP host with no user",     mail.isConfigured(env({ SMTP_HOST: "mail.host.com" })), false);
check("a Brevo SMTP user with no key", mail.isConfigured(env({ BREVO_SMTP_USER: "x" })),       false);

// The API is the exception, and deliberately: a key with no sender DOES select
// the provider, so that problems() can say which variable is missing instead of
// the registry falling through to a different route or to silence.
check("an API key with no sender still selects the API",
  mail.provider(env({ BREVO_API_KEY: "xkeysib-x" })).name, "brevo-api");
check("and names the missing sender",
  /BREVO_SENDER_EMAIL/.test(mail.problems(env({ BREVO_API_KEY: "xkeysib-x" })).join(" ")), true);

console.log("--- the sender address ---");

check("the API sends as BREVO_SENDER_EMAIL",
  mail.fromAddress(env(API)), "no-reply@offlineschool.vgrp.org");
check("and is ready without EMAIL_FROM", mail.problems(env(API)), []);
check("EMAIL_FROM still overrides it",
  mail.fromAddress(env({ ...API, EMAIL_FROM: "office@school.com" })), "office@school.com");

// The old fallback chain ended at noreply@schoolapp.com — a domain this project
// does not own, which Brevo rejects and any receiving server may treat as
// forged.
check("the SMTP relay without EMAIL_FROM has no sender to invent",
  mail.fromAddress(env({ BREVO_SMTP_USER: "x", BREVO_SMTP_KEY: "y" })), null);
check("and says so rather than trying",
  mail.problems(env({ BREVO_SMTP_USER: "x", BREVO_SMTP_KEY: "y" })).length, 1);
check("naming the variable to set",
  /EMAIL_FROM/.test(mail.problems(env({ BREVO_SMTP_USER: "x", BREVO_SMTP_KEY: "y" }))[0]), true);
check("a generic SMTP host the same",
  mail.problems(env({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" })).length, 1);

console.log("--- a cosmetic omission is not an outage ---");

/*
 * THE REGRESSION THIS SECTION EXISTS FOR.
 *
 * transport() throws CHANNEL_NOT_CONFIGURED when problems() is non-empty, so
 * every entry in that list disables all email. BREVO_SENDER_NAME was in it —
 * meaning a school that had not set a display name sent nothing at all, while
 * the log line said "mail will still send". Blocking faults and advisory ones
 * are now separate lists, and this asserts the distinction rather than the
 * wording.
 */
const NO_NAME = { BREVO_API_KEY: API.BREVO_API_KEY, BREVO_SENDER_EMAIL: API.BREVO_SENDER_EMAIL };

check("a missing display name is not a problem",   mail.problems(env(NO_NAME)), []);
check("it is an advisory",                         mail.advisories(env(NO_NAME)).length, 1);
check("naming the variable",
  /BREVO_SENDER_NAME/.test(mail.advisories(env(NO_NAME))[0]), true);

let sendableWithoutName = false;
try { mail.transport(env(NO_NAME)); sendableWithoutName = true; } catch { /* recorded below */ }
mail.reset();
check("and mail still sends without it", sendableWithoutName, true);

check("a fully configured account has no advisories", mail.advisories(env(API)), []);
check("and an unconfigured one has none either — those are problems",
  mail.advisories(env()), []);

console.log("--- credentials are cleaned the same way for every provider ---");

for (const [label, vars, path] of [
  ["Brevo SMTP", RELAY, ["auth", "pass"]],
  ["SMTP",       SMTP,  ["auth", "pass"]],
]) {
  const spaced = { ...vars };
  // A key copied out of a browser picks up a trailing newline as easily as
  // Google's app password arrived in four spaced groups.
  for (const k of Object.keys(spaced)) {
    if (k !== "EMAIL_FROM") spaced[k] = ` ${spaced[k]} \n`;
  }
  const built = mail.provider(env(spaced)).build(env(spaced));
  const value = path.reduce((o, k) => o?.[k], built);
  check(`${label}: no whitespace survives into the credential`,
    /\s/.test(String(value)), false);
}

// The API key gets the same treatment, one layer down: the adapter reads it,
// so the assertion is that a pasted newline does not reach Brevo as part of
// the credential.
const brevo = require("../src/services/email.brevo");
check("Brevo API: no whitespace survives into the key",
  /\s/.test(String(brevo.apiKey({ BREVO_API_KEY: ` ${API.BREVO_API_KEY} \n` }))), false);
check("and the key itself is unchanged otherwise",
  brevo.apiKey({ BREVO_API_KEY: ` ${API.BREVO_API_KEY} \n` }), API.BREVO_API_KEY);

console.log("--- no provider means a refusal, not a doomed connection ---");

// It used to default to smtp.mailtrap.io, so an unconfigured deployment
// authenticated against a third party and failed with a message about
// credentials rather than about configuration.
let threw = null;
try { mail.transport(env()); } catch (err) { threw = err; }
mail.reset();
check("transport() throws", Boolean(threw), true);
check("with the code the dispatcher records a SKIP for, not a retry",
  threw?.code, "CHANNEL_NOT_CONFIGURED");
check("and a message naming what to set",
  /BREVO_API_KEY|BREVO_SENDER_EMAIL|SMTP_HOST/.test(threw?.message ?? ""), true);
check("and not a retired provider's variable",
  /SENDGRID|GMAIL/.test(threw?.message ?? ""), false);

const everything = env({ ...API, ...RELAY, ...SMTP });
const hosts = Object.fromEntries(
  mail.PROVIDERS
    // The API entry has no SMTP options to build; it carries its own transport.
    .filter((p) => p.build(everything) !== null)
    .map((p) => [p.name, p.build(everything).host])
);
check("and no provider points at a host nobody configured",
  hosts, {
    "brevo-smtp": "smtp-relay.brevo.com",
    smtp:         "mail.host.com",
  });

console.log("--- the API entry supplies a transport of its own ---");

// The one structural difference between this provider and every other: Brevo's
// API is HTTP, so the entry hands over an object that already implements
// sendMail() rather than options for nodemailer. Both send sites call exactly
// that method, and this asserts the shape they depend on.
const apiEntry = mail.PROVIDERS.find((p) => p.name === "brevo-api");
check("it declares makeTransport",       typeof apiEntry.makeTransport, "function");
check("which yields a sendMail()",       typeof apiEntry.makeTransport(env(API)).sendMail, "function");
check("and transport() returns it",
  typeof mail.transport(env(API)).sendMail, "function");
mail.reset();

console.log("--- an assigned template id actually reaches a send ---");

/*
 * WHY THIS SECTION IS LONGER THAN IT LOOKS LIKE IT NEEDS TO BE.
 *
 * A Brevo template id is configured in one place (the environment) and used in
 * another (a send site), joined by a string key. Every joint in that chain can
 * be wrong in a way that produces NO error at all: a purpose name that no
 * TEMPLATE_VARS entry matches, a notification kind that is not in the enum, a
 * template name that email.service does not render. In each case the school
 * assigns an id in the Brevo panel, sees no failure, and every message goes
 * out with the wording compiled into this repository.
 *
 * That is unfalsifiable from the outside, so it is asserted from the inside.
 */

const brevoVars     = Object.keys(brevo.TEMPLATE_VARS);
const emailService  = require("../src/services/email.service");
const Notification  = require("../src/db/models/Notification");
const enumKinds     = Notification.schema.path("kind").enumValues;
const emailCh       = channels.getChannel("email");

// ── the queue side ──────────────────────────────────────────────────────────

const kindMap = Object.fromEntries(
  enumKinds.map((k) => [k, emailCh.purposeFor(k)]).filter(([, v]) => v)
);

check("every kind the queue maps is a real Notification.kind",
  Object.keys(kindMap).filter((k) => !enumKinds.includes(k)), []);
check("and every purpose it names is a real Brevo template purpose",
  Object.values(kindMap).filter((v) => !brevoVars.includes(v)), []);
check("the money and attendance kinds are all mapped",
  Object.keys(kindMap).sort(),
  ["attendance.absent", "fee.payment", "fee.reminder", "gate.arrival", "gate.departure", "result.published"]);
check("an unknown kind maps to nothing rather than guessing",
  emailCh.purposeFor("something.else"), null);
check("and so does a missing one",
  emailCh.purposeFor(undefined), null);

// ── the direct-send side ────────────────────────────────────────────────────

check("every template name in the purpose map is one this service renders",
  Object.keys(emailService.TEMPLATE_PURPOSE).filter((t) => !emailService.TEMPLATE_NAMES.includes(t)), []);
check("and every purpose it names is a real Brevo template purpose",
  Object.values(emailService.TEMPLATE_PURPOSE).filter((v) => !brevoVars.includes(v)), []);

// ── the join: which purposes are reachable at all ───────────────────────────

const reachable = new Set([
  ...Object.values(kindMap),
  ...Object.values(emailService.TEMPLATE_PURPOSE),
]);
const unreachable = brevoVars.filter((v) => !reachable.has(v));

/*
 * verifyEmail is the one purpose with no send behind it, and that is a fact
 * about this backend rather than an oversight: there is no email-verification
 * flow here. Accounts are created BY an administrator, who types the address,
 * and the credentials are mailed to it — nobody self-registers, so there is
 * nothing to verify and no route that would send it.
 *
 * It is asserted rather than deleted so that the day somebody adds that flow,
 * this line fails and points at the variable that is already waiting for it.
 * If this assertion breaks because the list grew, a purpose was added without
 * a caller — which is the dead-variable bug, not a passing test.
 */
check("exactly one purpose has no send behind it", unreachable, ["verifyEmail"]);

// ── and the gate in front of all of it ──────────────────────────────────────

const WITH_ID = { ...API, BREVO_TEMPLATE_FEE_REMINDER: "1234" };

check("an assigned id is returned for its purpose",
  mail.templateFor("feeReminder", env(WITH_ID)), 1234);
check("an unassigned purpose is null, which means send our own HTML",
  mail.templateFor("welcome", env(WITH_ID)), null);
check("a purpose that does not exist is null, not a crash",
  mail.templateFor("nonsense", env(WITH_ID)), null);
check("and a null purpose is null",
  mail.templateFor(null, env(WITH_ID)), null);

/*
 * THE ASSERTION THAT MATTERS MOST HERE. nodemailer ignores a templateId, so
 * handing one to an SMTP transport does not fail — it sends the old wording
 * and reports success. A school on the SMTP relay that assigns template ids
 * must get the app's HTML, and nothing must pretend otherwise.
 */
check("an SMTP transport is never handed a template id",
  mail.templateFor("feeReminder", env({ ...RELAY, BREVO_TEMPLATE_FEE_REMINDER: "1234" })), null);
check("nor a generic SMTP host",
  mail.templateFor("feeReminder", env({ ...SMTP, BREVO_TEMPLATE_FEE_REMINDER: "1234" })), null);
check("nor an unconfigured deployment",
  mail.templateFor("feeReminder", env({ BREVO_TEMPLATE_FEE_REMINDER: "1234" })), null);

// A non-numeric id is treated as unset rather than passed on: Brevo requires a
// number and would answer 400, which reads as a send failure rather than as
// the configuration mistake it is.
check("a non-numeric id is treated as unset",
  mail.templateFor("feeReminder", env({ ...API, BREVO_TEMPLATE_FEE_REMINDER: "template-3" })), null);
check("and so is a zero",
  mail.templateFor("feeReminder", env({ ...API, BREVO_TEMPLATE_FEE_REMINDER: "0" })), null);

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

  Object.assign(process.env, API);
  check("both agree: the Brevo API is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);

  for (const k of Object.keys(API)) delete process.env[k];
  Object.assign(process.env, RELAY);
  check("both agree: the Brevo SMTP relay is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);

  for (const k of Object.keys(RELAY)) delete process.env[k];
  Object.assign(process.env, SMTP);
  check("both agree: a generic SMTP host is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);

  // And they must agree about the retired ones too, in the other direction:
  // this is the case that would put fee reminders in a log file while the
  // bursar was told they had been sent.
  for (const k of Object.keys(SMTP)) delete process.env[k];
  Object.assign(process.env, SENDGRID, GMAIL);
  check("both agree: a stale SendGrid and Gmail are NOT configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [false, false]);
} finally {
  for (const k of ALL) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  mail.reset();
}

console.log("--- describe() is safe to paste into a support thread ---");

const shownApi = JSON.stringify(mail.describe(env(API)));
check("the API key does not appear in it",
  shownApi.includes(API.BREVO_API_KEY), false);
check("but its shape does",
  new RegExp(`${API.BREVO_API_KEY.length} chars`).test(shownApi), true);
check("and the sender is named, because that is not a secret",
  shownApi.includes("no-reply@offlineschool.vgrp.org"), true);
check("as is the reply-to, for the same reason",
  shownApi.includes("support@vgrp.org"), true);
check("the advisory list travels with it",
  JSON.parse(JSON.stringify(mail.describe(env(NO_NAME)))).advisories.length, 1);

const shownRelay = JSON.stringify(mail.describe(env(RELAY)));
check("the SMTP key does not appear either",
  shownRelay.includes("xsmtpsib-key"), false);
check("but its shape does",
  /12 chars/.test(shownRelay), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
