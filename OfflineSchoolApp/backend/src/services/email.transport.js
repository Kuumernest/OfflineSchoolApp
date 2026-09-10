// backend/src/services/email.transport.js
"use strict";

const nodemailer = require("nodemailer");
const brevoApi   = require("./email.brevo");

/**
 * Where email physically goes, decided once.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * There were two answers to "how does this app send email", and they did not
 * agree:
 *
 *   email.service.js  — welcome emails and password resets. Understood
 *                       SendGrid, then Gmail, then a generic SMTP host.
 *   notification/channels.js — fee reminders, and everything else the queue
 *                       carries. Understood GMAIL ONLY, hard-coded
 *                       service:"gmail", and reported isConfigured() as false
 *                       for any other provider.
 *
 * So moving a school onto SendGrid used to half-work in the worst possible way:
 * staff would get their credentials, and every fee reminder would be quietly
 * routed to the LOG channel — because resolveChannel() asks
 * emailChannel.isConfigured(), that answered false, and the fallback chain ends
 * at a channel that always "succeeds" by printing to stdout. The bursar would
 * press Send, be told the reminders went, and they would be in a server log.
 *
 * That is the same shape of bug as the one fixed in the previous commit — a
 * layer reporting success for something that never left the building — reached
 * through a different door. One definition closes the door.
 *
 * ── Order of precedence ───────────────────────────────────────────────────
 *
 * A dedicated provider wins over Gmail, deliberately. Migrating off a personal
 * Gmail should be two lines ADDED to .env, not two lines added and two deleted
 * — a half-finished edit that leaves both sets present must land on the one the
 * school is moving to, not the one it is leaving.
 */

/** Credentials as pasted, cleaned up — see the note on cred() below. */
const cred = (v) => (typeof v === "string" ? v.replace(/\s+/g, "") : v);

/**
 * Whitespace is stripped from every credential, not just Gmail's.
 *
 * Google displays an app password as four spaced groups ("abcd efgh ijkl mnop")
 * so it arrives in .env with the spaces still in it, and Gmail answers
 * 535-5.7.8, which reads exactly like a wrong password. SendGrid keys and Brevo
 * SMTP keys are long enough that a copy out of a browser can pick up a trailing
 * newline just as easily. None of this rescues a genuinely wrong credential; it
 * removes a cause that is indistinguishable from one.
 */
const PROVIDERS = [
  {
    /*
     * Brevo's Transactional Email API — the provider this app now uses.
     *
     * First in the list, so a deployment that still has SMTP variables lying
     * around lands on the API rather than on whatever it is migrating away
     * from. The precedence note below applies: a half-finished edit must
     * resolve to the provider the school is moving TO.
     *
     * The odd one out in this registry: every other entry describes an SMTP
     * host for nodemailer, and this one speaks HTTP. makeTransport exists for
     * exactly that — see the note on it in transport() below. What both send
     * sites see is unchanged: an object with .sendMail().
     */
    name:   "brevo-api",
    label:  "Brevo (Transactional API)",
    detect: (e) => Boolean(e.BREVO_API_KEY),
    // No SMTP options to build; the adapter holds the client.
    build:  () => null,
    makeTransport: () => brevoApi,
    /*
     * Brevo will not send from an address on a domain that has not been
     * authenticated in the account, so there is no default worth guessing at.
     * BREVO_SENDER_EMAIL is the one the adapter reads; EMAIL_FROM still works
     * and wins, so an existing deployment keeps whatever it had.
     */
    requiresFrom: true,
    vars: ["BREVO_API_KEY", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME", "BREVO_REPLY_TO"],
    describe: (e) => brevoApi.describe(e),
  },
  {
    /*
     * Brevo over SMTP, kept as a fallback for the same provider.
     *
     * Not a second email system: the same account, the same authenticated
     * domain, a different route to it. It is below the API deliberately, and
     * it stays because a deployment that cannot reach Brevo's HTTP endpoint
     * — a school behind a proxy that permits 587 and not 443 — has somewhere
     * to go without a code change.
     */
    name:  "brevo-smtp",
    label: "Brevo (SMTP relay)",
    detect: (e) => Boolean(e.BREVO_SMTP_USER && e.BREVO_SMTP_KEY),
    build: (e) => ({
      host: "smtp-relay.brevo.com", port: 587, secure: false,
      auth: {
        // Brevo's SMTP login, which is NOT the account's login email — the
        // panel shows it as something like 8a1b2c001@smtp-brevo.com.
        user: String(e.BREVO_SMTP_USER).trim(),
        pass: cred(e.BREVO_SMTP_KEY),
      },
    }),
    requiresFrom: true,
    vars: ["BREVO_SMTP_USER", "BREVO_SMTP_KEY", "EMAIL_FROM"],
  },
  /*
   * SendGrid and Gmail were here, and are gone deliberately.
   *
   * The app sends through Brevo now. Leaving those entries in the registry
   * would mean a deployment with a stale SENDGRID_API_KEY or a GMAIL_USER
   * still in its environment could resolve to a provider nobody intends to
   * use — silently, because this registry picks the first match and reports
   * success. That is the failure this file was written to prevent, and
   * keeping a retired provider "just in case" is how it comes back.
   *
   * GMAIL_USER, GMAIL_APP_PASSWORD and SENDGRID_API_KEY are now read by
   * nothing. A school still on either must move to Brevo; there is no code
   * path back.
   *
   * Generic SMTP below is kept: it is not a retired provider but the escape
   * hatch for a self-hosted relay and for a local mail catcher in
   * development.
   */
  {
    name:  "smtp",
    label: "SMTP",
    detect: (e) => Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS),
    build: (e) => ({
      // No default host. There used to be one — smtp.mailtrap.io — which meant
      // a half-configured deployment silently tried to authenticate against a
      // third party's server and failed with a message about credentials
      // rather than about configuration.
      host:   String(e.SMTP_HOST).trim(),
      port:   Number.parseInt(e.SMTP_PORT, 10) || 587,
      secure: e.SMTP_SECURE === "true",
      auth: { user: String(e.SMTP_USER).trim(), pass: cred(e.SMTP_PASS) },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     15_000,
    }),
    requiresFrom: true,
    vars: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"],
  },
];

/** Which provider this environment describes, or null for none. */
const provider = (env = process.env) =>
  PROVIDERS.find((p) => p.detect(env)) ?? null;

/** Is email configured at all? The one question both send paths now ask. */
const isConfigured = (env = process.env) => provider(env) !== null;

/**
 * The address mail is sent FROM.
 *
 * Returns null rather than a plausible-looking default. The old fallback chain
 * ended at "noreply@schoolapp.com", a domain this project does not own — which
 * SendGrid and Brevo reject outright, and which any receiving server is
 * entitled to treat as forged. A missing sender is a configuration mistake and
 * has to read as one.
 */
const fromAddress = (env = process.env) => {
  const explicit = (env.EMAIL_FROM || "").trim();
  if (explicit) return explicit;

  const p = provider(env);
  if (!p) return null;
  // The API adapter has its own sender variable, which is the one Brevo
  // authenticates. EMAIL_FROM above still wins, so a deployment that already
  // set it keeps working.
  if (p.name === "brevo-api") return brevoApi.sender(env).email;
  return null;
};

/**
 * Everything wrong with the current configuration, in the order it matters.
 *
 * Returned as a list rather than thrown so the startup log, the diagnostic
 * script and a send failure can all say the same thing.
 */
const problems = (env = process.env) => {
  const p = provider(env);
  if (!p) {
    return [
      "No email provider is configured. Set BREVO_API_KEY and " +
      "BREVO_SENDER_EMAIL (the supported provider), or, for a self-hosted " +
      "relay, SMTP_HOST + SMTP_USER + SMTP_PASS.",
    ];
  }

  // The API adapter knows its own requirements — the key, the authenticated
  // sender — and phrases them once. Asking it keeps one description of what
  // is wrong rather than two that can drift.
  if (p.name === "brevo-api") return brevoApi.problems(env);

  const out = [];
  if (p.requiresFrom && !fromAddress(env)) {
    out.push(
      `${p.label} needs EMAIL_FROM set to an address verified in that account. ` +
      "It will not send from an unverified sender."
    );
  }
  return out;
};

/**
 * The Brevo template id for a purpose, or null — asked before every send.
 *
 * Two things have to be true for a template to be used, and they are checked
 * here rather than at the two send sites, so neither has to know which
 * provider is in force:
 *
 *   · the active provider can render one. Only Brevo's API can; handing a
 *     templateId to nodemailer would be silently ignored, which is the worst
 *     outcome — a school would assign an id in the panel, see no error, and
 *     get the old wording.
 *   · an id is actually configured for that purpose. Unset is the ordinary
 *     state and means "send the HTML this app renders", not "fail".
 *
 * `purpose` is a key of email.brevo TEMPLATE_VARS, never a raw number, so a
 * caller cannot hard-code an id that belongs to somebody else's account.
 */
const templateFor = (purpose, env = process.env) => {
  if (provider(env)?.name !== "brevo-api") return null;
  return brevoApi.templateId(purpose, env);
};

/**
 * Faults worth reporting that do not stop a send.
 *
 * Deliberately NOT part of problems(): transport() throws on anything in that
 * list, so a merely cosmetic omission there would take email out entirely.
 * The startup log prints both, distinguished.
 */
const advisories = (env = process.env) => {
  const p = provider(env);
  if (p?.name === "brevo-api") return brevoApi.advisories(env);
  return [];
};

// One transporter per provider shape, reused. Built lazily: constructing it at
// import time would make every script that merely requires this file open a
// connection.
let cached = null;
let cachedFor = null;

/**
 * The transport, or a thrown CHANNEL_NOT_CONFIGURED.
 *
 * The error code matters: notification/channels.js is expected to throw exactly
 * that so the dispatcher records a skip the admin list can display, rather than
 * a delivery failure that will be retried forever.
 */
const transport = (env = process.env) => {
  const p = provider(env);
  if (!p) {
    const err = new Error(problems(env)[0]);
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  const issues = problems(env);
  if (issues.length) {
    const err = new Error(issues.join(" "));
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  if (cached && cachedFor === p.name) return cached;

  /*
   * A provider may bring its own transport.
   *
   * Every SMTP entry here hands nodemailer an options object. Brevo's API is
   * HTTP, so it supplies an object that already implements sendMail() — which
   * is the whole interface either send site uses. Nothing above this line and
   * nothing in email.service.js or notification/channels.js needs to know
   * which kind it got.
   */
  cached    = p.makeTransport
    ? p.makeTransport(env)
    : nodemailer.createTransport(p.build(env));
  cachedFor = p.name;
  return cached;
};

/** Drops the cached transport. For a diagnostic that changes env between tries. */
const reset = () => { cached = null; cachedFor = null; };

/**
 * A safe description for logs and the diagnostic — shape, never secrets.
 *
 * Lengths and a whitespace flag, because those are what actually go wrong with
 * a pasted credential, and neither reveals the value.
 */
const describe = (env = process.env) => {
  const p = provider(env);
  // The API adapter reports its own shape, including the template ids, and
  // reports the key by length only.
  if (p?.describe) return p.describe(env);
  const shape = (v) =>
    v === undefined || v === null || v === ""
      ? "unset"
      : `${String(v).length} chars${/\s/.test(String(v)) ? ", contains whitespace" : ""}`;

  return {
    provider: p?.name ?? null,
    label:    p?.label ?? "none",
    from:     fromAddress(env) ?? null,
    problems: problems(env),
    vars: Object.fromEntries(
      (p?.vars ?? ["BREVO_API_KEY", "BREVO_SMTP_USER", "SMTP_HOST"])
        .map((k) => [k, shape(env[k])])
    ),
  };
};

module.exports = {
  PROVIDERS,
  provider,
  isConfigured,
  fromAddress,
  problems,
  advisories,
  templateFor,
  transport,
  reset,
  describe,
};
