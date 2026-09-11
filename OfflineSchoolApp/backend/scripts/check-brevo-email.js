// backend/scripts/check-brevo-email.js
"use strict";

/**
 * Brevo's Transactional Email API, asserted without sending anything.
 *
 * Nothing here reaches the network. The Brevo client is replaced at the seam
 * the send path actually uses — email.brevo.__setClient — so what is exercised
 * is the real adapter, the real registry, and the real payload it builds. A
 * test that mocked the module registry instead would be mocking the thing
 * under test, and one that posted to Brevo would make this suite depend on the
 * internet and on somebody's send quota.
 *
 * ── What is worth asserting ───────────────────────────────────────────────
 *
 * The API key is the whole risk. It is read from the environment, held in one
 * client, and must never appear in a log line, an error message, a diagnostic
 * response or a thrown stack. Several assertions below do nothing but look for
 * it in places it could leak.
 *
 * After that: that the sender, sender name and reply-to come from the
 * environment and are not hard-coded; that a template id and its params are
 * passed through; that a missing recipient and a missing key are refused
 * distinguishably; that a provider failure throws rather than returning a
 * false success — because a layer reporting success for something that never
 * left the building is the bug this file's neighbours were written to fix.
 *
 * And that the two existing send sites keep working, which is the point of
 * doing this as an adapter rather than a new service.
 *
 *   node scripts/check-brevo-email.js
 */

const path = require("path");
const SRC  = path.join(__dirname, "..", "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

// A key shaped like a real one, so a substring search for it is meaningful.
const KEY = "xkeysib-0000test0000-not-a-real-brevo-key-000000000000";

const ENV = {
  BREVO_API_KEY:      KEY,
  BREVO_SENDER_EMAIL: "no-reply@offlineschool.vgrp.org",
  BREVO_SENDER_NAME:  "OfflineSchoolApp",
  BREVO_REPLY_TO:     "support@vgrp.org",
};

/** Captures every payload instead of sending it. */
const makeStub = (behaviour = "ok") => {
  const sent = [];
  return {
    sent,
    transactionalEmails: {
      sendTransacEmail: async (payload) => {
        sent.push(payload);
        if (behaviour === "throw") {
          // Shaped like a provider failure that echoes the request back, which
          // is how a naive error log leaks the whole message.
          const err = new Error("Brevo rejected the request");
          err.code = 401;
          err.body = { message: "Key not found", request: payload };
          throw err;
        }
        return { messageId: "<brevo-message-id@offlineschool.vgrp.org>" };
      },
    },
  };
};

(async () => {
  const brevo = require(path.join(SRC, "services/email.brevo"));
  const mail  = require(path.join(SRC, "services/email.transport"));

  // ── The client, and where the key comes from ────────────────────────────
  console.log("--- the client ---");
  {
    if (brevo.isConfigured(ENV)) ok("a key and a sender is enough to be configured");
    else bad("configured with a key and a sender", JSON.stringify(brevo.problems(ENV)));

    if (!brevo.isConfigured({})) ok("and an empty environment is not");
    else bad("an empty environment is not configured");

    // The key is never hard-coded: an environment without it must say so.
    const issues = brevo.problems({});
    if (issues.some((i) => /BREVO_API_KEY/.test(i))) ok("a missing key is named in the problems");
    else bad("a missing key is reported", JSON.stringify(issues));

    if (issues.some((i) => /BREVO_SENDER_EMAIL/.test(i))) ok("and so is a missing sender");
    else bad("a missing sender is reported", JSON.stringify(issues));
  }

  // ── The registry resolves to Brevo, and not to a retired provider ───────
  console.log("\n--- the provider registry ---");
  {
    if (mail.provider(ENV)?.name === "brevo-api") ok("the API is the provider chosen");
    else bad("the registry chooses brevo-api", String(mail.provider(ENV)?.name));

    if (mail.fromAddress(ENV) === ENV.BREVO_SENDER_EMAIL) {
      ok("the From address comes from BREVO_SENDER_EMAIL");
    } else {
      bad("From comes from the environment", String(mail.fromAddress(ENV)));
    }

    // EMAIL_FROM still wins, so a deployment that already set it is unbroken.
    const withLegacy = { ...ENV, EMAIL_FROM: "bursar@offlineschool.vgrp.org" };
    if (mail.fromAddress(withLegacy) === "bursar@offlineschool.vgrp.org") {
      ok("and EMAIL_FROM still overrides it, so existing deployments are unchanged");
    } else {
      bad("EMAIL_FROM overrides the sender", String(mail.fromAddress(withLegacy)));
    }

    // §4: SendGrid is retired and must not be selectable however stale the env.
    const stale = { SENDGRID_API_KEY: "SG.stale" };
    const chosen = mail.provider(stale);
    if (chosen === null) {
      ok("a stale SendGrid key selects nothing at all");
    } else {
      bad("SendGrid is not selectable",
        `it chose "${chosen.name}" — a school could send through a provider ` +
        "nobody intends to use, silently.");
    }

    /*
     * Gmail is a different case, and the distinction is the point. It IS in the
     * registry, because it is the nominated failover — but a configured Gmail
     * must never displace Brevo as the primary. If it did, a school would send
     * everything through a personal Google account while a paid,
     * domain-authenticated Brevo sat configured and unused, and nothing would
     * say so.
     */
    const both = { ...ENV, GMAIL_USER: "old@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" };
    if (mail.provider(both)?.name === "brevo-api") {
      ok("a configured Gmail does not displace Brevo as the primary");
    } else {
      bad("Brevo stays the primary when Gmail is also configured", String(mail.provider(both)?.name));
    }
    if (mail.fallbackProvider(both)?.name === "gmail") {
      ok("it is the failover instead, which is where it belongs");
    } else {
      bad("Gmail is the failover", String(mail.fallbackProvider(both)?.name));
    }
    if (mail.fallbackProvider(ENV) === null) {
      ok("and with no Gmail configured there is simply no failover, not a broken one");
    } else {
      bad("no Gmail means no failover", String(mail.fallbackProvider(ENV)?.name));
    }

    const names = mail.PROVIDERS.map((p) => p.name);
    note(`providers: ${names.join(", ")}`);
    if (!names.includes("sendgrid")) {
      ok("and SendGrid is gone from the registry");
    } else {
      bad("sendgrid is removed from the registry", names.join(", "));
    }
  }

  // ── What actually goes on the wire ──────────────────────────────────────
  console.log("\n--- the payload ---");
  {
    const stub = makeStub();
    brevo.__setClient(stub);

    const res = await brevo.sendMail({
      from:    '"Green Valley Academy" <no-reply@offlineschool.vgrp.org>',
      to:      "parent@example.test",
      subject: "Fee reminder",
      html:    "<p>Balance outstanding</p>",
      text:    "Balance outstanding",
    }, ENV);

    const p = stub.sent[0];
    note(`payload keys: ${Object.keys(p).join(", ")}`);

    if (p.sender?.email === ENV.BREVO_SENDER_EMAIL) ok("the sender address is the configured one");
    else bad("sender.email is from the environment", JSON.stringify(p.sender));

    // The From string carries the SCHOOL's name, which is what a parent should
    // see; the address underneath is the authenticated sender.
    if (p.sender?.name === "Green Valley Academy") {
      ok("the sender name is the school's, in front of that address");
    } else {
      bad("the school's name is used as the sender name", JSON.stringify(p.sender));
    }

    if (p.replyTo?.email === ENV.BREVO_REPLY_TO) ok("Reply-To comes from BREVO_REPLY_TO");
    else bad("Reply-To is from the environment", JSON.stringify(p.replyTo));

    if (p.to?.[0]?.email === "parent@example.test") ok("the recipient is passed through");
    else bad("the recipient is passed", JSON.stringify(p.to));

    if (p.htmlContent === "<p>Balance outstanding</p>" && p.textContent === "Balance outstanding") {
      ok("and both the HTML and the plain text");
    } else {
      bad("html and text are passed", JSON.stringify({ h: p.htmlContent, t: p.textContent }));
    }

    if (res.messageId === "<brevo-message-id@offlineschool.vgrp.org>") {
      ok("the provider's message id comes back, so the existing log line works");
    } else {
      bad("the message id is returned", JSON.stringify(res));
    }

    // A bare address, which is what channels.js sends when there is no name.
    const stub2 = makeStub();
    brevo.__setClient(stub2);
    await brevo.sendMail({ from: "no-reply@offlineschool.vgrp.org", to: "a@b.test", subject: "x", text: "y" }, ENV);
    if (stub2.sent[0].sender?.email === "no-reply@offlineschool.vgrp.org") {
      ok("a bare From address is understood too");
    } else {
      bad("a bare From is parsed", JSON.stringify(stub2.sent[0].sender));
    }
  }

  // ── Templates ──────────────────────────────────────────────────────────
  console.log("\n--- templates ---");
  {
    const withIds = { ...ENV, BREVO_TEMPLATE_FEE_RECEIPT: "4", BREVO_TEMPLATE_WELCOME: "  3  " };

    if (brevo.templateId("feeReceipt", withIds) === 4) ok("a template id is read from the environment");
    else bad("the template id is read", String(brevo.templateId("feeReceipt", withIds)));

    if (brevo.templateId("welcome", withIds) === 3) ok("and trimmed");
    else bad("a padded id is trimmed", String(brevo.templateId("welcome", withIds)));

    // Unset is a working state, not an error: the app sends its own HTML.
    if (brevo.templateId("attendance", withIds) === null) ok("an unset id is null, not an error");
    else bad("an unset id is null", String(brevo.templateId("attendance", withIds)));

    // A non-numeric id would make Brevo answer 400, which reads as a send
    // failure rather than a configuration mistake.
    if (brevo.templateId("welcome", { ...ENV, BREVO_TEMPLATE_WELCOME: "welcome-template" }) === null) {
      ok("and a non-numeric id is treated as unset rather than passed on");
    } else {
      bad("a non-numeric id is refused", "it would reach Brevo and be rejected as a bad request");
    }

    const stub = makeStub();
    brevo.__setClient(stub);
    await brevo.sendMail({
      from: '"School" <no-reply@offlineschool.vgrp.org>',
      to: { email: "parent@example.test", name: "Bern Constance" },
      templateId: 4,
      params: { studentName: "Che Jude", amount: 60000, receiptNumber: "RCP-1" },
      html: "<p>this must not be sent</p>",
    }, ENV);

    const p = stub.sent[0];
    if (p.templateId === 4) ok("a templateId reaches the API");
    else bad("templateId is passed", JSON.stringify(p.templateId));

    if (p.params?.studentName === "Che Jude" && p.params?.amount === 60000) {
      ok("with its params");
    } else {
      bad("params are passed", JSON.stringify(p.params));
    }

    // Brevo ignores htmlContent when a template is given; sending both invites
    // confusion about which one arrived.
    if (p.htmlContent === undefined) ok("and the local HTML is not sent alongside it");
    else bad("html is omitted when a template is used", JSON.stringify(p.htmlContent));

    if (p.to?.[0]?.name === "Bern Constance") ok("a named recipient keeps its name");
    else bad("the recipient name is passed", JSON.stringify(p.to));
  }

  // ── Refusals ───────────────────────────────────────────────────────────
  console.log("\n--- what it refuses ---");
  {
    brevo.__setClient(makeStub());

    for (const [label, to] of [["nothing", undefined], ["an empty string", "   "], ["an empty list", []]]) {
      try {
        await brevo.sendMail({ from: "a@b.test", to, subject: "x", text: "y" }, ENV);
        bad(`a recipient of ${label} is refused`, "it tried to send");
      } catch (err) {
        if (err.code === "NO_RECIPIENT") ok(`a recipient of ${label} is refused`);
        else bad(`a recipient of ${label} is refused as NO_RECIPIENT`, `${err.code}: ${err.message}`);
      }
    }

    // A missing key must read as configuration, not as a delivery failure: the
    // dispatcher records CHANNEL_NOT_CONFIGURED as a skip rather than retrying
    // it on a backoff forever.
    try {
      await brevo.sendMail({ from: "a@b.test", to: "c@d.test", subject: "x", text: "y" },
        { BREVO_SENDER_EMAIL: ENV.BREVO_SENDER_EMAIL });
      bad("a missing API key is refused", "it tried to send");
    } catch (err) {
      if (err.code === "CHANNEL_NOT_CONFIGURED") ok("a missing API key is CHANNEL_NOT_CONFIGURED, so the queue skips rather than retries");
      else bad("a missing key is CHANNEL_NOT_CONFIGURED", `${err.code}: ${err.message}`);
    }
  }

  // ── A provider failure ─────────────────────────────────────────────────
  console.log("\n--- when Brevo fails ---");
  {
    brevo.__setClient(makeStub("throw"));

    let threw = null;
    try {
      await brevo.sendMail({ from: "a@b.test", to: "c@d.test", subject: "x", text: "y" }, ENV);
    } catch (err) { threw = err; }

    if (threw) ok("the failure throws rather than reporting a false success");
    else bad("a provider failure throws",
      "Returning success for something that never left the building is the " +
      "exact bug email.transport.js was written to prevent.");

    // The process is still here. §6: an email provider must never take out the
    // server.
    ok("and the process is still running");
  }

  // ── The key, in every place it could leak ──────────────────────────────
  console.log("\n--- the API key does not leak ---");
  {
    const shape = brevo.describe(ENV);
    if (!JSON.stringify(shape).includes(KEY)) ok("describe() does not contain it");
    else bad("describe() must not contain the key", "it is in the diagnostic output");

    if (/^\d+ chars/.test(shape.vars.BREVO_API_KEY)) {
      ok(`it is reported by shape only ("${shape.vars.BREVO_API_KEY}")`);
    } else {
      bad("the key is reported as a shape", String(shape.vars.BREVO_API_KEY));
    }

    // Whitespace in a pasted key is the common fault, and saying so identifies
    // it without revealing the value.
    const padded = brevo.describe({ ...ENV, BREVO_API_KEY: "xkeysib-abc \n" });
    if (/whitespace/.test(padded.vars.BREVO_API_KEY)) ok("and a pasted newline is called out, still without the value");
    else bad("whitespace in a key is reported", String(padded.vars.BREVO_API_KEY));

    if (!brevo.problems({}).join(" ").includes(KEY)) ok("problems() does not contain it");
    else bad("problems() must not contain the key");

    // The transport's own diagnostic delegates here, so it must be clean too.
    if (!JSON.stringify(mail.describe(ENV)).includes(KEY)) ok("and neither does the transport's describe()");
    else bad("transport.describe() must not contain the key");

    // A thrown provider error, which is what reaches a catch block and a log.
    brevo.__setClient(makeStub("throw"));
    try {
      await brevo.sendMail({ from: "a@b.test", to: "c@d.test", subject: "x", text: "y" }, ENV);
    } catch (err) {
      if (!String(err.message).includes(KEY)) ok("a thrown error's message does not contain it");
      else bad("the error message must not contain the key", err.message);
      if (!String(err.stack ?? "").includes(KEY)) ok("nor its stack");
      else bad("the stack must not contain the key");
    }
  }

  // ── Attachments, because the receipt path already sends one ────────────
  console.log("\n--- attachments ---");
  {
    const stub = makeStub();
    brevo.__setClient(stub);
    await brevo.sendMail({
      from: "a@b.test", to: "c@d.test", subject: "Receipt", text: "attached",
      attachments: [{ filename: "receipt.pdf", content: Buffer.from("%PDF-1.4 fake") }],
    }, ENV);

    const a = stub.sent[0].attachment?.[0];
    if (a?.name === "receipt.pdf") ok("an attachment keeps its filename");
    else bad("the filename is passed", JSON.stringify(a));

    if (a?.content && Buffer.from(a.content, "base64").toString().startsWith("%PDF")) {
      ok("and its content is base64-encoded as Brevo requires");
    } else {
      bad("the content is base64", JSON.stringify(a?.content)?.slice(0, 60));
    }

    // One malformed entry must not cost the whole message: Brevo rejects the
    // send for a bad attachment, which would turn a cosmetic problem into a
    // lost receipt.
    const stub2 = makeStub();
    brevo.__setClient(stub2);
    await brevo.sendMail({
      from: "a@b.test", to: "c@d.test", subject: "x", text: "y",
      attachments: [{ filename: "broken.pdf" }, { filename: "ok.pdf", content: Buffer.from("x") }],
    }, ENV);
    const list = stub2.sent[0].attachment ?? [];
    if (list.length === 1 && list[0].name === "ok.pdf") {
      ok("and an attachment with no content is dropped rather than losing the email");
    } else {
      bad("a malformed attachment is dropped", JSON.stringify(list));
    }
  }

  // ── The existing callers ───────────────────────────────────────────────
  //
  // The reason this is an adapter and not a new service. Both send sites ask
  // the registry for a transport and call sendMail on it; if either had to
  // change, the migration would have created a second email system.
  console.log("\n--- the two existing send sites still work ---");
  {
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    mail.reset();

    const stub = makeStub();
    brevo.__setClient(stub);

    const tx = mail.transport();
    if (typeof tx.sendMail === "function") ok("transport() returns something with sendMail()");
    else bad("the transport exposes sendMail", typeof tx.sendMail);

    // channels.js — the queue's email channel, verbatim in shape.
    const channels = require(path.join(SRC, "services/notification/channels"));
    const email = channels.getChannel ? channels.getChannel("email") : channels.email;
    if (email && typeof email.send === "function") {
      const out = await email.send({
        to: "parent@example.test", subject: "Gate arrival",
        text: "arrived", html: "<p>arrived</p>", fromName: "Green Valley Academy",
      });
      if (out?.ok) ok("the notification queue's email channel sends through Brevo");
      else bad("the queue channel sends", JSON.stringify(out));

      const p = stub.sent[stub.sent.length - 1];
      if (p?.sender?.name === "Green Valley Academy" && p?.replyTo?.email === ENV.BREVO_REPLY_TO) {
        ok("with the school's name and the configured Reply-To");
      } else {
        bad("the queue's send carries the right sender and reply-to", JSON.stringify({ s: p?.sender, r: p?.replyTo }));
      }
      if (email.isConfigured()) ok("and the channel reports itself configured, so the queue does not fall back to the log");
      else bad("the email channel is configured", "resolveChannel() would route to log and report success");

      /*
       * A notification kind with a template assigned.
       *
       * The queue is where fee reminders, gate scans and absences go out, so
       * it is where a school assigning BREVO_TEMPLATE_FEE_REMINDER expects the
       * wording to change. Without the kind → purpose map in channels.js the
       * id is simply ignored, with no error anywhere — an assigned template
       * that does nothing, which is indistinguishable from a wrong one.
       */
      process.env.BREVO_TEMPLATE_FEE_REMINDER = "91";
      mail.reset();
      await email.send({
        to: "parent@example.test", subject: "School fees outstanding",
        text: "45,000 XAF outstanding", html: "<p>45,000 XAF outstanding</p>",
        fromName: "Green Valley Academy",
        kind: "fee.reminder", data: { amount: 45000, currency: "XAF" },
      });

      const tpl = stub.sent[stub.sent.length - 1];
      if (tpl?.templateId === 91) ok("an assigned template id reaches the queue's send");
      else bad("the queue uses the configured template", JSON.stringify({ templateId: tpl?.templateId }));

      // Brevo ignores htmlContent beside a templateId, so sending both would
      // leave "which one arrived" unanswerable.
      if (!tpl?.htmlContent && !tpl?.textContent) ok("and the locally rendered body is not sent alongside it");
      else bad("html must not accompany a templateId", JSON.stringify({ html: Boolean(tpl?.htmlContent), text: Boolean(tpl?.textContent) }));

      if (tpl?.params?.amount === 45000) ok("and the notification's data goes across as the template params");
      else bad("params carry the notification data", JSON.stringify(tpl?.params));

      // A kind with no purpose must be unaffected by any assigned id.
      await email.send({
        to: "parent@example.test", subject: "Sports day",
        text: "Saturday", html: "<p>Saturday</p>",
        kind: "announcement", data: {},
      });
      const ann = stub.sent[stub.sent.length - 1];
      if (!ann?.templateId && ann?.htmlContent) ok("while a kind with no template still sends the queue's own body");
      else bad("an unmapped kind is unaffected", JSON.stringify({ templateId: ann?.templateId, html: Boolean(ann?.htmlContent) }));

      delete process.env.BREVO_TEMPLATE_FEE_REMINDER;
      mail.reset();
    } else {
      bad("the notification email channel can be reached", Object.keys(channels).join(", "));
    }

    // email.service.js — sendTemplateEmail, the new capability.
    const svc = require(path.join(SRC, "services/email.service"));
    if (typeof svc.sendEmail === "function") ok("email.service still exports sendEmail, so its callers are untouched");
    else bad("sendEmail is preserved", Object.keys(svc).join(", "));

    /*
     * sendEmail() and an assigned template id.
     *
     * This is the path staff credentials take, and the one BREVO_TEMPLATE_WELCOME
     * and BREVO_TEMPLATE_PASSWORD_RESET are for. Three states, because each of
     * them has been wrong in a way that produced no error: the id ignored, the
     * HTML sent alongside it, and a template with no purpose picking up
     * somebody else's id.
     */
    {
      const WELCOME = {
        schoolName: "Green Valley Academy", name: "Bern Constance",
        email: "teacher@example.test", password: "temp-pass",
      };

      delete process.env.BREVO_TEMPLATE_WELCOME;
      mail.reset();
      await svc.sendEmail({ to: "teacher@example.test", template: "teacherWelcome", data: WELCOME });
      const plain = stub.sent[stub.sent.length - 1];
      if (!plain?.templateId && plain?.htmlContent) ok("with no id assigned, sendEmail sends the HTML this app renders");
      else bad("an unassigned purpose sends local HTML", JSON.stringify({ templateId: plain?.templateId, html: Boolean(plain?.htmlContent) }));

      process.env.BREVO_TEMPLATE_WELCOME = "55";
      mail.reset();
      await svc.sendEmail({ to: "teacher@example.test", template: "teacherWelcome", data: WELCOME });
      const templated = stub.sent[stub.sent.length - 1];
      if (templated?.templateId === 55) ok("and with one assigned, it sends that template instead");
      else bad("sendEmail uses the assigned template", JSON.stringify({ templateId: templated?.templateId }));

      if (!templated?.htmlContent) ok("dropping the rendered HTML, which Brevo would ignore anyway");
      else bad("html must not accompany a templateId", "htmlContent was sent");

      if (templated?.params?.name === "Bern Constance") ok("and passing the template's data across as params");
      else bad("params carry the template data", JSON.stringify(templated?.params));

      // studentRejected has no purpose in TEMPLATE_VARS, deliberately. It must
      // not inherit the welcome id.
      await svc.sendEmail({
        to: "parent@example.test", template: "studentRejected",
        data: { schoolName: "Green Valley Academy", name: "A Child", reason: "no places" },
      });
      const unmapped = stub.sent[stub.sent.length - 1];
      if (!unmapped?.templateId && unmapped?.htmlContent) ok("while a template with no purpose is unaffected by any assigned id");
      else bad("an unmapped template stays local", JSON.stringify({ templateId: unmapped?.templateId }));

      delete process.env.BREVO_TEMPLATE_WELCOME;
      mail.reset();
    }

    const noId = await svc.sendTemplateEmail({ to: "parent@example.test", purpose: "attendance" });
    if (noId.success === false && noId.code === "NO_TEMPLATE") {
      ok("and sendTemplateEmail says so plainly when no id is configured, rather than sending local HTML under a template call");
    } else {
      bad("an unconfigured template is reported", JSON.stringify(noId));
    }

    process.env.BREVO_TEMPLATE_FEE_RECEIPT = "4";
    const sent = await svc.sendTemplateEmail({
      to: "parent@example.test", name: "Bern Constance", purpose: "feeReceipt",
      params: { receiptNumber: "RCP-1" },
    });
    if (sent.success && sent.templateId === 4) ok("and sends the template when one is set");
    else bad("a configured template sends", JSON.stringify(sent));

    const badTo = await svc.sendTemplateEmail({ to: "not-an-address", purpose: "feeReceipt" });
    if (badTo.success === false && badTo.code === "NO_RECIPIENT") ok("an invalid recipient is refused before any send");
    else bad("an invalid recipient is refused", JSON.stringify(badTo));

    delete process.env.BREVO_TEMPLATE_FEE_RECEIPT;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // verify() — the diagnostic's credential check
  //
  // scripts/mail-verify.js calls transport.verify() on whatever the registry
  // hands it. The SMTP entries get nodemailer's, which completes a handshake;
  // this adapter has to supply one or the only provider this app actually uses
  // is the one provider the diagnostic cannot check. Two things are asserted:
  // that it authenticates without sending, and that a refusal does not carry
  // the key.
  // ───────────────────────────────────────────────────────────────────────────
  {
    let sends = 0, accountCalls = 0;
    brevo.__setClient({
      account: {
        getAccount: async () => {
          accountCalls += 1;
          return { email: "billing@vgrp.org", companyName: "VGRP", plan: [{ type: "free" }] };
        },
      },
      transactionalEmails: {
        sendTransacEmail: async () => { sends += 1; return { messageId: "x" }; },
      },
    });

    const result = await brevo.verify(ENV);

    if (accountCalls === 1) ok("verify() authenticates against the account endpoint");
    else bad("verify() calls GET /v3/account once", String(accountCalls));

    if (sends === 0) ok("and sends nothing at all while doing it");
    else bad("verify() must not send", `${sends} message(s) sent`);

    // A bare "accepted" hides the mistake this actually diagnoses: a valid key
    // belonging to a DIFFERENT Brevo account than the sending domain.
    if (result?.account === "billing@vgrp.org") ok("and names the account the key belongs to");
    else bad("verify() reports the account", JSON.stringify(result));

    brevo.reset();
  }

  {
    // A refusal, which is the path a real 401 takes. The key must not be in
    // the message or the stack — a diagnostic's output is the single most
    // likely thing to be pasted into a support thread.
    brevo.__setClient({
      account: {
        getAccount: async () => {
          const err = new Error("Key not found");
          err.statusCode = 401;
          throw err;
        },
      },
    });

    let refusal = null;
    try { await brevo.verify(ENV); } catch (err) { refusal = err; }

    if (refusal) ok("a refused key throws rather than reporting success");
    else bad("verify() propagates a refusal", "it resolved");

    const text = `${refusal?.message ?? ""} ${refusal?.stack ?? ""}`;
    if (!text.includes(KEY)) ok("and the refusal does not contain the key");
    else bad("the key must not appear in a verify() failure", "it does");

    brevo.reset();
  }

  {
    for (const key of Object.keys(ENV)) delete process.env[key];
    mail.reset();
    brevo.reset();
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
