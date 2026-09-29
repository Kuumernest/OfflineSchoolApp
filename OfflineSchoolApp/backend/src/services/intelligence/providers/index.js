// backend/src/services/intelligence/providers/index.js
"use strict";

/**
 * Which explanation provider the application uses.
 *
 * Read once from the environment, lazily, on the first request that could
 * use a model. Nothing here is required to run the app: unset, or set to
 * `none`, the null provider answers every operation with
 * PROVIDER_NOT_CONFIGURED and the caller falls back to the deterministic
 * explanation — which is also the offline road, always.
 *
 * A misspelt provider name is reported once and treated as `none`: a school
 * does not lose its explanation service over a typo in a .env file, it loses
 * the optional narration and keeps the deterministic answer.
 *
 * No provider receives tools, database access, the filesystem, the shell, or
 * user management. A provider receives one request object built by
 * shared/advancedIntelligence/provider.js and returns one object of the
 * output contract. That is the whole interface.
 */

const { NullProvider, isProvider } = require("../../../../../shared/advancedIntelligence/provider");

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIMEOUT_MS = 20000;

let warned = false;

const providerFromEnv = (env = process.env) => {
  const kind = String(env.ADVANCED_INTELLIGENCE_PROVIDER ?? "none").trim().toLowerCase();
  if (!kind || kind === "none" || kind === "off" || kind === "false") return new NullProvider();
  if (kind === "anthropic") {
    const { AnthropicProvider } = require("./anthropic.provider");
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      model: env.ADVANCED_INTELLIGENCE_MODEL || DEFAULT_MODEL,
      timeoutMs: Number(env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) > 0 ? Number(env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
      effort: env.ADVANCED_INTELLIGENCE_EFFORT || "low",
      fallbacks: String(env.ADVANCED_INTELLIGENCE_MODEL_FALLBACKS ?? "default").toLowerCase() !== "off",
    });
  }
  if (!warned) { warned = true; console.warn(`[advanced-intelligence] unknown ADVANCED_INTELLIGENCE_PROVIDER "${kind}" — using none (deterministic explanation only)`); }
  return new NullProvider();
};

module.exports = { providerFromEnv, isProvider, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS };
