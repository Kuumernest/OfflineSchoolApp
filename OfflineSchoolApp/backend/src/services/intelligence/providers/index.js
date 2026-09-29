// backend/src/services/intelligence/providers/index.js
"use strict";

/**
 * Which explanation provider the application uses.
 *
 * Read from the environment, lazily, on the first request that could use a
 * model. Nothing here is required to run the app: unset, or set to `none`,
 * the null provider answers every operation with PROVIDER_NOT_CONFIGURED
 * and the caller falls back to the deterministic explanation — which is
 * also the offline road, always.
 *
 * `anthropic` needs ANTHROPIC_API_KEY. Without one the provider is not
 * constructed at all: the SDK would defer the failure to the first request,
 * and a school server is better told once at the first explanation that
 * nothing is configured than shown an authentication error later. The key
 * is read here and handed to the adapter; it is never logged, never put in
 * an audit block, never returned.
 *
 * A misspelt provider name is reported once and treated as `none`: a school
 * does not lose its explanation service over a typo in a .env file, it
 * loses the optional narration and keeps the deterministic answer.
 *
 * No provider receives tools, database access, the filesystem, the shell,
 * or user management. A provider receives one request object built by
 * shared/advancedIntelligence/provider.js and returns one object of the
 * output contract. That is the whole interface, and this directory is the
 * only place in the application that knows an SDK exists.
 */

const { NullProvider, isProvider } = require("../../../../../shared/advancedIntelligence/provider");

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 20000;

const warnedFor = new Set();
const warnOnce = (key, message) => { if (!warnedFor.has(key)) { warnedFor.add(key); console.warn(`[advanced-intelligence] ${message}`); } };

/** The configuration the environment describes, with the key reported as present or not, never as a value. */
const describeConfig = (env = process.env) => {
  const kind = String(env.ADVANCED_INTELLIGENCE_PROVIDER ?? "none").trim().toLowerCase();
  return {
    provider: !kind || kind === "off" || kind === "false" ? "none" : kind,
    model: env.ANTHROPIC_MODEL || env.ADVANCED_INTELLIGENCE_MODEL || DEFAULT_MODEL,
    apiKeyPresent: Boolean(env.ANTHROPIC_API_KEY && String(env.ANTHROPIC_API_KEY).trim()),
    workspaceIdPresent: Boolean(env.ANTHROPIC_WORKSPACE_ID && String(env.ANTHROPIC_WORKSPACE_ID).trim()),
    timeoutMs: Number(env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) > 0 ? Number(env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    effort: env.ADVANCED_INTELLIGENCE_EFFORT || "low",
    fallbacks: ["on", "true", "default", "1"].includes(String(env.ADVANCED_INTELLIGENCE_MODEL_FALLBACKS ?? "off").trim().toLowerCase()),
  };
};

const providerFromEnv = (env = process.env) => {
  const c = describeConfig(env);
  if (c.provider === "none") return new NullProvider();
  if (c.provider === "anthropic") {
    if (!c.apiKeyPresent) { warnOnce("no-key", "ADVANCED_INTELLIGENCE_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — using none (deterministic explanation only)"); return new NullProvider(); }
    const { AnthropicProvider } = require("./anthropic.provider");
    return new AnthropicProvider({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), workspaceId: c.workspaceIdPresent ? String(env.ANTHROPIC_WORKSPACE_ID).trim() : null, model: c.model, timeoutMs: c.timeoutMs, effort: c.effort, fallbacks: c.fallbacks });
  }
  warnOnce(`unknown:${c.provider}`, `unknown ADVANCED_INTELLIGENCE_PROVIDER "${c.provider}" — using none (deterministic explanation only)`);
  return new NullProvider();
};

module.exports = { providerFromEnv, describeConfig, isProvider, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS };
