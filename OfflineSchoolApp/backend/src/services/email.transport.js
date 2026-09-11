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
    // Bound to the env this transport was built from. Returning the module
    // itself meant it read process.env regardless of what it was handed.
    makeTransport: (env) => brevoApi.bind(env),
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
   * SendGrid was here and is gone. It is read by nothing, and an environment
   * still holding SENDGRID_API_KEY resolves to no provider rather than
   * quietly routing through one the school has stopped paying for.
   *
   * Gmail is BELOW generic SMTP, and that position is the whole point: it is
   * the designated FAILOVER, not a competing primary. A school with both
   * Brevo and Gmail configured sends everything through Brevo, and Gmail is
   * reached only when an individual Brevo send has actually failed — see
   * fallbackProvider() and the failover transport further down. It is last
   * here so that "which provider is this deployment on?" cannot accidentally
   * answer "the fallback" while Brevo sits configured and unused.
   *
   * Generic SMTP is the escape hatch for a self-hosted relay and for a local
   * mail catcher in development.
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
  {
    /*
     * Gmail — the failover.
     *
     * Last in the list deliberately (see the note above): as a PRIMARY it is
     * chosen only when nothing else is configured at all. Its real job is
     * fallbackProvider() below, where it catches a Brevo send that failed.
     *
     * It needs no EMAIL_FROM because Google will not let it send as anything
     * but the authenticated account — which is also why the failover rewrites
     * the From address on the way through. Sending as no-reply@ a domain
     * Google has not authorised gets the message rewritten or rejected, so the
     * fallback keeps the school's display NAME and swaps the address.
     */
    name:  "gmail",
    label: "Gmail",
    detect: (e) => Boolean(e.GMAIL_USER && e.GMAIL_APP_PASSWORD),
    build: (e) => ({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: {
        user: String(e.GMAIL_USER).trim(),
        // Google shows an app password as four spaced groups
        // ("abcd efgh ijkl mnop"), so it reaches .env with the spaces still in
        // it and Gmail answers 535 — which reads exactly like a wrong password.
        pass: cred(e.GMAIL_APP_PASSWORD),
      },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     15_000,
    }),
    // Gmail sends as itself; there is nothing to configure and nothing to
    // verify in a provider account.
    requiresFrom: false,
    vars: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
  },
];

/** The provider nominated to catch a failed send, or null. */
const FAILOVER = "gmail";

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
  // Gmail can only send as the account that authenticated, so there is nothing
  // to guess at and nothing to verify in a provider panel.
  if (p.name === "gmail") return String(env.GMAIL_USER || "").trim() || null;
  return null;
};

/**
 * Everything wrong with the current configuration, in the order it matters.
 *
 * Returned as a list rather than thrown so the startup log, the diagnostic
 * script and a send failure can all say the same thing.
 */
/** What is wrong with ONE named provider, ignoring which is selected. */
const providerProblems = (p, env = process.env) => {
  if (!p) return ["No email provider is configured."];
  if (p.name === "brevo-api") return brevoApi.problems(env);
  if (p.requiresFrom && !(env.EMAIL_FROM || "").trim()) {
    return [
      `${p.label} needs EMAIL_FROM set to an address verified in that account. ` +
      "It will not send from an unverified sender.",
    ];
  }
  return [];
};

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
 * The provider that catches a failed send, or null if there is none.
 *
 * Gmail, and only Gmail — it is the one nominated in FAILOVER. Null when Gmail
 * is not configured, and null when Gmail IS the primary, because a fallback
 * behind itself would mean sending the same message to the same server twice.
 */
const fallbackProvider = (env = process.env) => {
  const primary = provider(env);
  if (!primary || primary.name === FAILOVER) return null;
  const fb = PROVIDERS.find((x) => x.name === FAILOVER);
  return fb && fb.detect(env) ? fb : null;
};

/**
 * Did this failure definitely mean the message was NOT accepted?
 *
 * ── Why this is not simply "catch everything and retry" ───────────────────
 *
 * Retrying through Gmail turns one failed send into one delivered message —
 * unless Brevo had in fact accepted it, in which case it turns one delivered
 * message into two. A parent receiving the same fee reminder twice is a small
 * harm; a teacher receiving two different temporary passwords is a support
 * call. So the question is not "did we get an error" but "do we know the
 * message was not accepted".
 *
 *   definitely not sent   refused before or instead of acceptance —
 *                         unconfigured, a 4xx, DNS failure, connection
 *                         refused. Brevo said no, or was never reached.
 *   possibly sent         a timeout or a 5xx AFTER the request went out.
 *                         Brevo may have queued it and failed to tell us.
 *
 * The ambiguous cases do NOT fail over. They surface as failures, which the
 * notification queue already handles: it records the attempt and retries on
 * its own backoff, and a retry that finds Brevo healthy sends exactly once.
 * Preferring a possible non-delivery over a possible duplicate is the
 * deliberate choice here, and it is the one the caller can recover from.
 */
const definitelyNotSent = (err) => {
  // Not a provider failure at all — a bad address fails the same way twice.
  if (err?.code === "NO_RECIPIENT") return false;
  if (err?.code === "CHANNEL_NOT_CONFIGURED") return true;

  const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? null;
  if (typeof status === "number") return status < 500;

  const code = String(err?.code ?? "");
  // Never reached the server, or was refused at the transport layer.
  if (/^(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EAUTH|EDNS)/.test(code)) return true;
  // Went out, and we do not know what happened to it.
  if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|ESOCKET)/.test(code)) return false;
  if (/timeout/i.test(String(err?.message ?? ""))) return false;

  // An error we do not recognise. Treated as not sent, because the common
  // unknown is a rejection and a lost message is the worse outcome.
  return true;
};

/** `"School" <a@b.c>` → the same display name in front of a different address. */
const rewriteFrom = (from, address) => {
  if (!address) return from;
  const name = String(from ?? "").match(/^\s*"?([^"<]*?)"?\s*</);
  return name && name[1].trim() ? `"${name[1].trim()}" <${address}>` : address;
};

/**
 * One transport in front of two, so neither send site learns about failover.
 *
 * email.service.js and notification/channels.js both call
 * `mail.transport().sendMail(...)` and neither should have to know there is a
 * second provider behind the first — that knowledge belongs in the registry,
 * which is the entire reason this file exists. What they get back is still an
 * object with sendMail(); it simply tries harder.
 */
const withFailover = (primaryTx, primaryEntry, fbTx, fbEntry, env) => ({
  primary:  primaryEntry.name,
  fallback: fbEntry.name,

  verify: (...args) =>
    (typeof primaryTx.verify === "function" ? primaryTx.verify(...args) : undefined),

  sendMail: async (message) => {
    try {
      return await primaryTx.sendMail(message);
    } catch (err) {
      /*
       * Everything below runs only when Brevo has actually failed. The log
       * carries the provider, the code and the message — never the key, and
       * never the provider's echoed request, which contains the whole email.
       */
      if (!definitelyNotSent(err)) {
        console.error(
          `📭 ${primaryEntry.label} failed and MAY have accepted the message — ` +
          `not retrying through ${fbEntry.label}, to avoid sending it twice.`,
          { code: err?.code ?? null, error: err?.message }
        );
        throw err;
      }

      /*
       * A Brevo template leaves nothing for Gmail to send: when templateId is
       * set the wording lives in Brevo's account, not in this message. Both
       * send sites therefore pass the rendered html/text as well, and this is
       * the guard for the case where something does not — an empty email is
       * worse than a reported failure.
       */
      if (!message?.html && !message?.text) {
        console.error(
          `📭 ${primaryEntry.label} failed and the message has no body to send ` +
          `through ${fbEntry.label} (template-only). Reporting the failure.`,
          { code: err?.code ?? null, error: err?.message }
        );
        throw err;
      }

      console.warn(
        `📭 ${primaryEntry.label} send failed — retrying through ${fbEntry.label}`,
        { code: err?.code ?? null, error: err?.message }
      );

      // templateId and params mean nothing to nodemailer, and the address has
      // to become the Gmail account or Google rewrites or rejects it.
      const { templateId, params, ...rest } = message ?? {};

      let info;
      try {
        info = await fbTx.sendMail({
          ...rest,
          from: rewriteFrom(message?.from, String(env.GMAIL_USER || "").trim()),
        });
      } catch (fbErr) {
        /*
         * Both providers refused it, and the fallback's error alone is
         * actively misleading: "535 authentication failed" reads as though
         * Gmail were the provider this school sends through, and sends
         * whoever is on call to the wrong panel. So the thrown error names
         * both, and keeps each one reachable.
         */
        console.error(
          `📭 Both providers failed for this message — ` +
          `${primaryEntry.label} then ${fbEntry.label}.`,
          {
            primary:  { code: err?.code ?? null,   error: err?.message },
            failover: { code: fbErr?.code ?? null, error: fbErr?.message },
          }
        );
        const both = new Error(
          `${primaryEntry.label} failed (${err?.message}) and the ` +
          `${fbEntry.label} failover also failed (${fbErr?.message})`
        );
        both.code         = fbErr?.code ?? err?.code ?? null;
        both.primaryError = err;
        both.failoverError = fbErr;
        throw both;
      }

      console.log(`📧 Delivered through ${fbEntry.label} after ${primaryEntry.label} failed`);
      return {
        ...info,
        provider:     fbEntry.name,
        failedOver:   true,
        primaryError: err?.message ?? null,
      };
    }
  },
});

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

  const fb     = fallbackProvider(env);
  const issues = problems(env);

  /*
   * A half-configured primary with a working fallback.
   *
   * Brevo with a key but no authenticated sender cannot send anything, and
   * before the fallback existed that meant no email at all. Now it means the
   * fallback becomes the primary, loudly: the school's mail keeps moving while
   * somebody fixes the configuration, rather than stopping silently on a
   * variable nobody noticed was blank.
   */
  if (issues.length) {
    if (fb && !providerProblems(fb, env).length) {
      console.warn(
        `⚠️  ${p.label} is not usable — sending through ${fb.label} instead. ` +
        `Fix: ${issues[0]}`
      );
      if (cached && cachedFor === fb.name) return cached;
      cached    = nodemailer.createTransport(fb.build(env));
      cachedFor = fb.name;
      return cached;
    }
    const err = new Error(issues.join(" "));
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  const cacheKey = fb ? `${p.name}+${fb.name}` : p.name;
  if (cached && cachedFor === cacheKey) return cached;

  /*
   * A provider may bring its own transport.
   *
   * Every SMTP entry here hands nodemailer an options object. Brevo's API is
   * HTTP, so it supplies an object that already implements sendMail() — which
   * is the whole interface either send site uses. Nothing above this line and
   * nothing in email.service.js or notification/channels.js needs to know
   * which kind it got.
   */
  const primaryTx = p.makeTransport
    ? p.makeTransport(env)
    : nodemailer.createTransport(p.build(env));

  cached = fb
    ? withFailover(primaryTx, p, nodemailer.createTransport(fb.build(env)), fb, env)
    : primaryTx;
  cachedFor = cacheKey;
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
  const p  = provider(env);
  const fb = fallbackProvider(env);
  // What catches a failed send, by shape. Reported alongside whatever the
  // primary says about itself, so "is there a safety net?" is answerable from
  // the startup log without opening the environment.
  const failover = fb
    ? { provider: fb.name, label: fb.label, as: String(env.GMAIL_USER || "").trim() || null }
    : null;

  // The API adapter reports its own shape, including the template ids, and
  // reports the key by length only.
  if (p?.describe) return { ...p.describe(env), failover };
  const shape = (v) =>
    v === undefined || v === null || v === ""
      ? "unset"
      : `${String(v).length} chars${/\s/.test(String(v)) ? ", contains whitespace" : ""}`;

  return {
    provider: p?.name ?? null,
    label:    p?.label ?? "none",
    from:     fromAddress(env) ?? null,
    failover,
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
  providerProblems,
  advisories,
  fallbackProvider,
  definitelyNotSent,
  FAILOVER,
  templateFor,
  transport,
  reset,
  describe,
};
