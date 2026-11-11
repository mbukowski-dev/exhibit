import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ExhibitConfig } from "./config.js";
import { withProviderErrors } from "./provider-errors.js";
import { PRICES, UsageMeter } from "./usage.js";

export const DEFAULT_MODELS = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5", // set model.name to override
} as const;

/** BYOK: keys come from the environment (GitHub Secrets in CI). */
export function createModel(
  cfg: ExhibitConfig["model"],
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  const name = cfg.name ?? DEFAULT_MODELS[cfg.provider];
  switch (cfg.provider) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
      return withProviderErrors(createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(name), "anthropic");
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      return withProviderErrors(createOpenAI({ apiKey: env.OPENAI_API_KEY })(name), "openai");
    }
  }
}

export function modelName(cfg: ExhibitConfig["model"]): string {
  return cfg.name ?? DEFAULT_MODELS[cfg.provider];
}

export function hasModelKey(cfg: ExhibitConfig["model"], env: NodeJS.ProcessEnv = process.env) {
  return Boolean(cfg.provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
}

const KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;

/**
 * Picks the model to use. Explicit overrides win; otherwise, when the
 * configured provider has no key but the other one does, switch to it, so
 * "just set a key" works without editing .exhibit.yml.
 */
export function resolveModelConfig(
  cfg: ExhibitConfig["model"],
  overrides: { provider?: "anthropic" | "openai"; name?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): { model: ExhibitConfig["model"]; note?: string } {
  let provider = overrides.provider ?? cfg.provider;
  let note: string | undefined;
  if (!overrides.provider && !env[KEY_ENV[provider]]) {
    const other = provider === "anthropic" ? "openai" : "anthropic";
    if (env[KEY_ENV[other]]) {
      note = `${KEY_ENV[provider]} is not set; using ${other} because ${KEY_ENV[other]} is.`;
      provider = other;
    }
  }
  const switched = provider !== cfg.provider;
  return { model: { ...cfg, provider, name: overrides.name ?? (switched ? undefined : cfg.name) }, note };
}

/** Cost meter for one run, using the configured price override if any. */
export function createMeter(cfg: ExhibitConfig["model"]): UsageMeter {
  const name = modelName(cfg);
  return new UsageMeter(name, cfg.max_cost_per_run_usd, cfg.price_per_mtok ?? PRICES[name]);
}
