// backend/src/services/intelligence/providers/anthropic.provider.js
"use strict";

/**
 * The Anthropic adapter — one implementation of the provider contract, and
 * the only file in the application that knows the Anthropic SDK exists
 * (the check scans every other file for it).
 *
 * ── What it is handed and what it returns ─────────────────────────────────
 *
 * One request built by shared/advancedIntelligence/provider.js: frozen
 * system instructions (no pupil data, no date — the same prefix on every
 * call, so it caches) and a sectioned user message holding the evidence
 * boundary, the deterministic findings, the answer facts, the whitelisted
 * evidence context, the citation index, the limitations, the permitted
 * behaviour and, last, the question wrapped as untrusted data. The model
 * is asked for one object of the output contract, enforced with a JSON
 * schema at the API (`output_config.format`); the text that comes back is
 * parsed and handed to the validator by the service. No tools are declared,
 * so the model has nothing to call; the SDK is given one request and no
 * capability beyond answering it.
 *
 * ── Failure ───────────────────────────────────────────────────────────────
 *
 * Every failure is thrown with a code or a status the service classifies:
 * a bad or missing key (401/403 → PROVIDER_AUTH), an unknown model (404 →
 * MODEL_UNAVAILABLE), a rate limit (429 → PROVIDER_QUOTA), a timeout, a
 * connection failure, a safety decline (`stop_reason: "refusal"` →
 * PROVIDER_REFUSED), an answer cut off or not JSON (INVALID_RESPONSE), and
 * anything else (PROVIDER_UNAVAILABLE). The service never surfaces a
 * provider error to a reader: it answers deterministically and records
 * why. Nothing here writes anywhere.
 *
 * ── The SDK ───────────────────────────────────────────────────────────────
 *
 * Required lazily, so the backend runs — and every check runs — without it
 * installed. The model name is configuration (ANTHROPIC_MODEL), never
 * written here; a different model may word an explanation differently and
 * can never change a state, because states are not computed on this path.
 */

const { renderUserMessage } = require("../../../../../shared/advancedIntelligence/provider");

const MAX_TOKENS = 4096;

// An organisation key that is not scoped to one workspace must name the
// workspace on every request; the API refuses it otherwise. The id is
// configuration (ANTHROPIC_WORKSPACE_ID), sent as a default header, and
// like the key it lives only in the client closure.
const clientFor = ({ apiKey, timeoutMs, workspaceId }) => {
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default ?? mod;
  return { Anthropic, client: new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) }) };
};

const failed = (message, code, status = null) => { const e = new Error(message); e.code = code; if (status) e.status = status; return e; };

class AnthropicProvider {
  constructor({ apiKey, workspaceId = null, model, timeoutMs, effort = "low", fallbacks = false } = {}) {
    this.name = "anthropic";
    this.model = model;
    this.configured = Boolean(apiKey);
    this.timeoutMs = timeoutMs;
    this.effort = effort;
    this.fallbacks = fallbacks;
    // The key lives in a closure, not on the instance: nothing that
    // serialises, logs or inspects the provider can reach it.
    this.sdkOf = () => { if (!this._sdk) this._sdk = clientFor({ apiKey, timeoutMs, workspaceId }); return this._sdk; };
  }

  /** What the audit may know: the name, the model, whether a key is present. Never the key. */
  describe() { return { provider: this.name, model: this.model, configured: this.configured, effort: this.effort, fallbacks: this.fallbacks, timeoutMs: this.timeoutMs }; }

  toJSON() { return this.describe(); }

  async run(request) {
    if (!this.configured) throw failed("no API key is configured for the Anthropic provider", "PROVIDER_AUTH", 401);
    let sdk;
    try { sdk = this.sdkOf(); } catch (err) { throw failed(`the Anthropic SDK is not installed: ${err.message}`, "PROVIDER_UNAVAILABLE"); }
    const { Anthropic, client } = sdk;
    const params = {
      model: this.model, max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: renderUserMessage(request) }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema: request.outputSchema } },
    };
    let res;
    try {
      res = this.fallbacks
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(params);
    } catch (err) {
      const is = (name) => Anthropic[name] && err instanceof Anthropic[name];
      if (is("AuthenticationError") || is("PermissionDeniedError")) throw failed(err.message, "PROVIDER_AUTH", err.status);
      // A key not scoped to a workspace, and no ANTHROPIC_WORKSPACE_ID: the
      // request is refused as a 400 naming the header. That is a credential
      // configuration problem, not an unavailable service.
      if (is("BadRequestError") && /workspace/i.test(String(err.message))) throw failed(`${err.message} (set ANTHROPIC_WORKSPACE_ID, or use a key scoped to a workspace)`, "PROVIDER_AUTH", 400);
      if (is("NotFoundError")) throw failed(err.message, "MODEL_UNAVAILABLE", 404);
      if (is("RateLimitError")) throw failed(err.message, "PROVIDER_QUOTA", 429);
      if (is("APIConnectionTimeoutError")) throw failed(err.message, "PROVIDER_TIMEOUT");
      if (is("APIConnectionError")) throw failed(err.message, "PROVIDER_UNAVAILABLE");
      if (is("APIError")) throw failed(err.message, "PROVIDER_UNAVAILABLE", err.status);
      throw err;
    }
    if (res.stop_reason === "refusal") throw failed(`the model declined (${res.stop_details?.category ?? "unspecified"})`, "PROVIDER_REFUSED");
    if (res.stop_reason === "max_tokens") throw failed("the model's answer was cut off", "INVALID_RESPONSE");
    const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw failed("the model did not return the structured object", "INVALID_RESPONSE"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failed("the model did not return the structured object", "INVALID_RESPONSE");
    return parsed;
  }

  explain(request) { return this.run(request); }
  summarize(request) { return this.run(request); }
  answer(request) { return this.run(request); }
}

module.exports = { AnthropicProvider, MAX_TOKENS };
