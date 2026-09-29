// backend/src/services/intelligence/providers/anthropic.provider.js
"use strict";

/**
 * The Anthropic adapter — one implementation of the provider contract.
 *
 * ── What it is handed and what it returns ─────────────────────────────────
 *
 * One request built by shared/advancedIntelligence/provider.js: frozen
 * system instructions (no pupil data, no date — the same prefix on every
 * call, so it caches), a structured input holding the whitelisted evidence
 * context, the deterministic synthesis and facts, the citation index, and
 * the pupil's question wrapped as untrusted data. The model is asked for
 * one object of the output contract, enforced with a JSON schema at the API
 * (`output_config.format`), and the text that comes back is parsed and
 * handed to the validator by the service. Nothing else: no tools are
 * declared, so the model has nothing to call.
 *
 * ── Failure ───────────────────────────────────────────────────────────────
 *
 * Every failure is thrown with a code or a status the service can classify
 * (timeout, quota, unavailable, refused, invalid). The service never
 * surfaces a provider error to a reader: it answers deterministically and
 * records why. A safety refusal by the model (`stop_reason: "refusal"`) is
 * PROVIDER_REFUSED — with server-side fallbacks on, the API has already
 * tried its fallback route before reporting one.
 *
 * The SDK is required lazily so the backend runs — and every check runs —
 * without it installed. A school with no provider has no reason to ship it.
 */

const MAX_TOKENS = 4096;

const clientFor = ({ apiKey, timeoutMs }) => {
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default ?? mod;
  return { Anthropic, client: new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: timeoutMs, maxRetries: 1 }) };
};

const failed = (message, code, status = null) => { const e = new Error(message); e.code = code; if (status) e.status = status; return e; };

class AnthropicProvider {
  constructor({ apiKey, model, timeoutMs, effort = "low", fallbacks = true } = {}) {
    this.name = "anthropic";
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.effort = effort;
    this.fallbacks = fallbacks;
    this.sdk = null;
  }

  sdkOf() { if (!this.sdk) this.sdk = clientFor({ apiKey: this.apiKey, timeoutMs: this.timeoutMs }); return this.sdk; }

  async run(request) {
    let sdk;
    try { sdk = this.sdkOf(); } catch (err) { throw failed(`the Anthropic SDK is not installed: ${err.message}`, "PROVIDER_UNAVAILABLE"); }
    const { Anthropic, client } = sdk;
    const params = {
      model: this.model, max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify({ operation: request.operation, constraints: request.constraints, input: request.input }) }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema: request.outputSchema } },
    };
    let res;
    try {
      res = this.fallbacks
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(params);
    } catch (err) {
      if (Anthropic.RateLimitError && err instanceof Anthropic.RateLimitError) throw failed(err.message, "PROVIDER_QUOTA", 429);
      if (Anthropic.APIConnectionTimeoutError && err instanceof Anthropic.APIConnectionTimeoutError) throw failed(err.message, "PROVIDER_TIMEOUT");
      if (Anthropic.APIConnectionError && err instanceof Anthropic.APIConnectionError) throw failed(err.message, "PROVIDER_UNAVAILABLE");
      if (Anthropic.APIError && err instanceof Anthropic.APIError) throw failed(err.message, "PROVIDER_UNAVAILABLE", err.status);
      throw err;
    }
    if (res.stop_reason === "refusal") throw failed(`the model declined (${res.stop_details?.category ?? "unspecified"})`, "PROVIDER_REFUSED");
    if (res.stop_reason === "max_tokens") throw failed("the model's answer was cut off", "INVALID_RESPONSE");
    const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    try { return JSON.parse(text); } catch { throw failed("the model did not return the structured object", "INVALID_RESPONSE"); }
  }

  explain(request) { return this.run(request); }
  summarize(request) { return this.run(request); }
  answer(request) { return this.run(request); }
}

module.exports = { AnthropicProvider, MAX_TOKENS };
