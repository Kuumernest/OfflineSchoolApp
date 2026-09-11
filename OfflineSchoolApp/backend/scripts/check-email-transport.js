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
 * ── Brevo primary, Gmail failover ─────────────────────────────────────────
 *
 * SendGrid was removed outright and this suite asserts its ABSENCE: a stale
 * SENDGRID_API_KEY in a deployed environment must not resolve to a provider
 * nobody intends to use, because the registry picks the first match and
 * reports success either way.
 *
 * Gmail is in the registry but holds a different job — it catches a Brevo send
 * that has actually failed. Two things therefore have to be true at once, and
 * both are asserted: a configured Gmail must never DISPLACE Brevo (or a school
 * sends everything through a personal account while a paid, authenticated
 * Brevo sits unused), and it must be REACHED when a Brevo send fails (or the
 * failover is decoration). The interesting assertions are about which failures
 * fail over — see the classification section.
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
  // The failover's credentials, and the one genuinely retired variable —
  // present so the cases below test the registry and not the developer's shell.
  "GMAIL_USER", "GMAIL_APP_PASSWORD",
  "SENDGRID_API_KEY",
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

console.log("--- SendGrid resolves to nothing at all ---");

// THE ASSERTION THAT GUARDS THE REMOVAL. A school that moved to Brevo will
// have a stale key sitting in its environment for a while, and an environment
// that still holds one must be treated as UNCONFIGURED rather than quietly
// routed through a provider the school has stopped paying for.
check("a stale SendGrid key selects no provider",  mail.provider(env(SENDGRID))?.name ?? null, null);
check("and is reported as not configured",         mail.isConfigured(env(SENDGRID)), false);
check("the name is not in the registry any more",
  mail.PROVIDERS.map((p) => p.name).filter((n) => n === "sendgrid"), []);
check("the registry is Brevo, the two SMTP routes, and the failover",
  mail.PROVIDERS.map((p) => p.name), ["brevo-api", "brevo-smtp", "smtp", "gmail"]);

console.log("--- Gmail is the failover, and never the primary by accident ---");

/*
 * THE DISTINCTION THIS WHOLE ARRANGEMENT RESTS ON.
 *
 * Gmail is last in the registry so it is chosen as a primary only when nothing
 * else is configured. If it ever outranked Brevo, a school would send every
 * fee reminder through a personal Google account — subject to Google's sending
 * limits and its spam treatment of bulk mail from an unauthenticated domain —
 * while a paid, domain-authenticated Brevo sat configured and idle, and
 * nothing anywhere would say so.
 */
check("Brevo stays primary when Gmail is also configured",
  mail.provider(env({ ...GMAIL, ...API })).name, "brevo-api");
check("and Gmail becomes the failover",
  mail.fallbackProvider(env({ ...GMAIL, ...API }))?.name ?? null, "gmail");
check("the Brevo SMTP relay keeps it as a failover too",
  mail.fallbackProvider(env({ ...GMAIL, ...RELAY }))?.name ?? null, "gmail");
check("as does a generic SMTP host",
  mail.fallbackProvider(env({ ...GMAIL, ...SMTP }))?.name ?? null, "gmail");

check("with nothing else configured, Gmail is the primary",
  mail.provider(env(GMAIL)).name, "gmail");
check("and then there is no failover behind it — it would be itself",
  mail.fallbackProvider(env(GMAIL)), null);
check("no Gmail means no failover at all",
  mail.fallbackProvider(env(API)), null);
check("and a half-configured Gmail is not a failover either",
  mail.fallbackProvider(env({ ...API, GMAIL_USER: "a@gmail.com" })), null);

check("Gmail sends as itself, so it needs no EMAIL_FROM",
  mail.fromAddress(env(GMAIL)), "school@gmail.com");
check("and is ready without one", mail.problems(env(GMAIL)), []);

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
check("and neither does a working Gmail",
  mail.provider(env({ ...GMAIL, ...API })).name, "brevo-api");
check("Gmail does not displace the relay either",
  mail.provider(env({ ...GMAIL, ...RELAY })).name, "brevo-smtp");
check("nor a generic SMTP host",
  mail.provider(env({ ...GMAIL, ...SMTP })).name, "smtp");

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
check("and not the retired provider's variable",
  /SENDGRID/.test(threw?.message ?? ""), false);

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
    gmail:        "smtp.gmail.com",
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

  // And they must agree about the retired one too, in the other direction:
  // this is the case that would put fee reminders in a log file while the
  // bursar was told they had been sent.
  for (const k of Object.keys(SMTP)) delete process.env[k];
  Object.assign(process.env, SENDGRID);
  check("both agree: a stale SendGrid is NOT configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [false, false]);

  // Gmail alone IS configured — it is a real provider again, just the last one.
  for (const k of Object.keys(SENDGRID)) delete process.env[k];
  Object.assign(process.env, GMAIL);
  check("both agree: Gmail alone is configured",
    [mail.isConfigured(), emailChannel.isConfigured()], [true, true]);
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

/*
 * The failover block is a new thing for describe() to carry, and describe()
 * is what GET /api/admin/email/config returns and what mail:verify prints.
 * The account address belongs there — it is not a secret, and "which mailbox
 * is behind this?" is the question being asked. The app password does not.
 */
const shownBoth = JSON.stringify(mail.describe(env({ ...API, ...GMAIL })));
check("the failover is described",
  JSON.parse(shownBoth).failover?.provider ?? null, "gmail");
check("naming the account, which is not a secret",
  JSON.parse(shownBoth).failover?.as ?? null, "school@gmail.com");
check("but never the app password",
  shownBoth.includes(GMAIL.GMAIL_APP_PASSWORD) || shownBoth.includes("abcdefghijklmnop"), false);
check("and no failover is reported as none, not omitted",
  JSON.parse(JSON.stringify(mail.describe(env(API)))).failover, null);

// Gmail as the primary: its own vars are then reported, and still by shape.
const shownGmail = JSON.stringify(mail.describe(env(GMAIL)));
check("Gmail as primary does not print its password either",
  shownGmail.includes(GMAIL.GMAIL_APP_PASSWORD) || shownGmail.includes("abcdefghijklmnop"), false);
check("but does report its shape, including the spaces Google displays",
  /19 chars, contains whitespace/.test(shownGmail), true);

const shownRelay = JSON.stringify(mail.describe(env(RELAY)));
check("the SMTP key does not appear either",
  shownRelay.includes("xsmtpsib-key"), false);
check("but its shape does",
  /12 chars/.test(shownRelay), true);

console.log("--- which failures fail over, and which must not ---");

/*
 * definitelyNotSent() is the whole duplicate-prevention rule, so it is asserted
 * directly rather than only through its effects.
 *
 * Retrying through Gmail turns one failed send into one delivered message —
 * unless Brevo had in fact accepted it, in which case it turns one delivered
 * message into two. A parent getting a fee reminder twice is a small harm; a
 * teacher getting two different temporary passwords is a support call.
 */
const notSent = mail.definitelyNotSent;

check("unconfigured: nothing was attempted",        notSent({ code: "CHANNEL_NOT_CONFIGURED" }), true);
check("a 400: Brevo refused it outright",           notSent({ statusCode: 400 }), true);
check("a 401: the key was rejected",                notSent({ statusCode: 401 }), true);
check("a 402: the account is out of credit",        notSent({ statusCode: 402 }), true);
check("DNS failure: never reached the server",      notSent({ code: "ENOTFOUND" }), true);
check("connection refused: same",                   notSent({ code: "ECONNREFUSED" }), true);

check("a 500: Brevo may have queued it",            notSent({ statusCode: 500 }), false);
check("a 503: same",                                notSent({ statusCode: 503 }), false);
check("a socket timeout: we do not know",           notSent({ code: "ETIMEDOUT" }), false);
check("a reset connection: we do not know",         notSent({ code: "ECONNRESET" }), false);
check("a message that merely says timeout",         notSent({ message: "Request timeout after 30s" }), false);

// Not a provider failure at all — a bad address fails identically on Gmail, so
// retrying achieves nothing and muddies the reported reason.
check("a bad recipient is not a provider failure",  notSent({ code: "NO_RECIPIENT" }), false);

// An unrecognised error is treated as not sent: the common unknown is a
// rejection, and a lost fee reminder is the worse of the two outcomes.
check("an unrecognised error is treated as not sent", notSent({ message: "something odd" }), true);

// ─────────────────────────────────────────────────────────────────────────────
// THE FAILOVER ITSELF
//
// Both providers are mocked. nodemailer.createTransport is replaced, so no
// socket is opened and Google is never contacted; the Brevo client is stubbed
// through the adapter's own injection point. Nothing here can send a real
// email, which is the point — a suite that could would eventually mail a
// parent during a test run.
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const nodemailer = require("nodemailer");
  const realCreate = nodemailer.createTransport;

  const BOTH = env({ ...API, ...GMAIL });

  /** Arms both providers and returns the recorders. */
  const arm = ({ brevoFails = null } = {}) => {
    const gmailSent = [];
    const brevoSent = [];

    nodemailer.createTransport = () => ({
      sendMail: async (msg) => { gmailSent.push(msg); return { messageId: "gmail-id" }; },
      verify:   async () => true,
    });

    brevo.__setClient({
      transactionalEmails: {
        sendTransacEmail: async (payload) => {
          if (brevoFails) throw brevoFails;
          brevoSent.push(payload);
          return { messageId: "brevo-id" };
        },
      },
    });

    mail.reset();
    return { gmailSent, brevoSent };
  };

  const MESSAGE = {
    from:    '"Green Valley Academy" <no-reply@offlineschool.vgrp.org>',
    to:      "parent@example.test",
    subject: "School fees outstanding",
    html:    "<p>45,000 XAF outstanding</p>",
    text:    "45,000 XAF outstanding",
  };

  console.log("--- the happy path sends exactly once ---");
  {
    const { gmailSent, brevoSent } = arm();
    const info = await mail.transport(BOTH).sendMail(MESSAGE);

    check("Brevo sent it", brevoSent.length, 1);
    // THE DUPLICATE-PREVENTION ASSERTION. If this ever reads 1, every email
    // this school sends is arriving twice.
    check("and Gmail was not touched", gmailSent.length, 0);
    check("the caller gets Brevo's id", info.messageId, "brevo-id");
    check("and is not told it failed over", info.failedOver ?? false, false);
  }

  console.log("--- a refused send goes through Gmail ---");
  {
    const refusal = new Error("Key not found");
    refusal.statusCode = 401;
    const { gmailSent, brevoSent } = arm({ brevoFails: refusal });

    const info = await mail.transport(BOTH).sendMail(MESSAGE);

    check("Brevo accepted nothing", brevoSent.length, 0);
    check("Gmail sent it once",     gmailSent.length, 1);
    check("exactly once",           gmailSent.length, 1);
    check("the caller is told which provider delivered it", info.provider, "gmail");
    check("and that it failed over", info.failedOver, true);

    /*
     * The From has to be rewritten. Google will not send as an address on a
     * domain it has not authorised — it rewrites or rejects — so the failover
     * keeps the school's display NAME, which is what a parent reads, and
     * swaps the address for the authenticated account.
     */
    check("the display name survives",
      /^"Green Valley Academy"/.test(gmailSent[0].from), true);
    check("and the address becomes the Gmail account",
      /<school@gmail\.com>$/.test(gmailSent[0].from), true);
    check("the body is intact",    gmailSent[0].html, MESSAGE.html);
    check("and so is the subject", gmailSent[0].subject, MESSAGE.subject);
  }

  console.log("--- an ambiguous failure does NOT go through Gmail ---");
  for (const [label, err] of [
    ["a 500", Object.assign(new Error("Internal error"), { statusCode: 500 })],
    ["a timeout", Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" })],
  ]) {
    const { gmailSent } = arm({ brevoFails: err });

    let threw = null;
    try { await mail.transport(BOTH).sendMail(MESSAGE); } catch (e) { threw = e; }

    check(`${label}: Gmail is not attempted`, gmailSent.length, 0);
    check(`${label}: and the failure is reported rather than hidden`, Boolean(threw), true);
  }

  console.log("--- a template-only message has nothing to fall back with ---");
  {
    // Brevo renders the wording from an id held in its own account, so a
    // message carrying only a templateId has no body Gmail could send. An
    // empty email is worse than a reported failure.
    const refusal = Object.assign(new Error("Key not found"), { statusCode: 401 });
    const { gmailSent } = arm({ brevoFails: refusal });

    let threw = null;
    try {
      await mail.transport(BOTH).sendMail({
        from: MESSAGE.from, to: MESSAGE.to, subject: MESSAGE.subject,
        templateId: 91, params: { amount: 45000 },
      });
    } catch (e) { threw = e; }

    check("Gmail is not sent an empty message", gmailSent.length, 0);
    check("and the failure is reported",        Boolean(threw), true);
  }

  console.log("--- but a template WITH a body does fall back ---");
  {
    // Which is why both send sites now pass html/text alongside templateId.
    const refusal = Object.assign(new Error("Key not found"), { statusCode: 401 });
    const { gmailSent } = arm({ brevoFails: refusal });

    await mail.transport(BOTH).sendMail({ ...MESSAGE, templateId: 91, params: { amount: 45000 } });

    check("Gmail sends the rendered body", gmailSent.length, 1);
    check("and the body is the app's own HTML", gmailSent[0].html, MESSAGE.html);
    // nodemailer would ignore these, but passing a provider's private fields
    // to a different provider is how a confusing bug starts.
    check("Brevo's template fields are stripped", gmailSent[0].templateId ?? null, null);
    check("including the params",                 gmailSent[0].params ?? null, null);
  }

  console.log("--- when both providers refuse it ---");
  {
    /*
     * The fallback's error alone is actively misleading: "535 authentication
     * failed" reads as though Gmail were the provider this school sends
     * through, and sends whoever is on call to the wrong panel. Both have to
     * be named.
     */
    const refusal = Object.assign(new Error("Key not found"), { statusCode: 401 });
    arm({ brevoFails: refusal });
    nodemailer.createTransport = () => ({
      sendMail: async () => { throw Object.assign(new Error("Invalid login: 535"), { code: "EAUTH" }); },
    });
    mail.reset();

    let threw = null;
    try { await mail.transport(BOTH).sendMail(MESSAGE); } catch (e) { threw = e; }

    check("the caller is told it failed", Boolean(threw), true);
    check("the message names the primary's failure",
      /Key not found/.test(threw?.message ?? ""), true);
    check("and the failover's",
      /535/.test(threw?.message ?? ""), true);
    check("with each error still reachable",
      [threw?.primaryError?.statusCode, threw?.failoverError?.code], [401, "EAUTH"]);
  }

  console.log("--- with no Gmail configured, a failure is just a failure ---");
  {
    const refusal = Object.assign(new Error("Key not found"), { statusCode: 401 });
    const { gmailSent } = arm({ brevoFails: refusal });

    let threw = null;
    try { await mail.transport(env(API)).sendMail(MESSAGE); } catch (e) { threw = e; }

    check("nothing is attempted behind it", gmailSent.length, 0);
    check("and the caller sees Brevo's error", threw?.message, "Key not found");
  }

  console.log("--- a half-configured Brevo falls back rather than stopping ---");
  {
    /*
     * A key with no authenticated sender cannot send anything. Before the
     * failover existed that meant no email at all — the school's mail stopped
     * on a blank variable nobody had noticed. Now it keeps moving through
     * Gmail, loudly, while somebody fixes the configuration.
     */
    const { gmailSent } = arm();
    const halfBrevo = env({ BREVO_API_KEY: API.BREVO_API_KEY, ...GMAIL });

    await mail.transport(halfBrevo).sendMail(MESSAGE);
    check("Gmail carries it", gmailSent.length, 1);
  }

  console.log("--- and no credential appears in any of it ---");
  {
    const refusal = Object.assign(new Error("Key not found"), { statusCode: 401 });
    const { gmailSent } = arm({ brevoFails: refusal });

    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) {
      console[k] = (...args) => lines.push(args.map((a) =>
        typeof a === "string" ? a : JSON.stringify(a)).join(" "));
    }
    try { await mail.transport(BOTH).sendMail(MESSAGE); }
    finally { Object.assign(console, real); }

    const logged = lines.join("\n");
    check("the failover logged something a maintainer can act on",
      /Gmail/.test(logged), true);
    check("the Brevo key is not in it",
      logged.includes(API.BREVO_API_KEY), false);
    check("nor the Gmail app password",
      logged.includes(GMAIL.GMAIL_APP_PASSWORD) ||
      logged.includes(GMAIL.GMAIL_APP_PASSWORD.replace(/\s/g, "")), false);
    check("and it did deliver", gmailSent.length, 1);
  }

  nodemailer.createTransport = realCreate;
  brevo.reset();
  mail.reset();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
