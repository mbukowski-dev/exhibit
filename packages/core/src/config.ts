import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ConfigSchema = z.object({
  tracker: z.enum(["jira"]).default("jira"),
  ticket_pattern: z
    .string()
    .default("[A-Z][A-Z0-9]+-\\d+")
    .refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: "ticket_pattern is not a valid regular expression" },
    ),
  preview_url: z.string().optional(),
  model: z
    .object({
      provider: z.enum(["anthropic", "openai"]).default("anthropic"),
      name: z.string().optional(),
      max_cost_per_run_usd: z.number().positive().default(1.5),
      /** [input, output] USD per 1M tokens, for models Exhibit has no price for. */
      price_per_mtok: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
      /** Reasoning effort per stage: review | plan | agent | infer → low | medium | high. */
      effort: z
        .object({
          review: z.enum(["low", "medium", "high"]).optional(),
          plan: z.enum(["low", "medium", "high"]).optional(),
          agent: z.enum(["low", "medium", "high"]).optional(),
          infer: z.enum(["low", "medium", "high"]).optional(),
        })
        .default({}),
    })
    // zod 4: prefault parses {} through the schema, so the inner defaults apply.
    .prefault({}),
  auth: z
    .array(
      z.object({
        role: z.string(),
        login_flow: z.string().optional(),
        username_env: z.string().optional(),
        password_env: z.string().optional(),
      }),
    )
    .default([]),
  mode: z.enum(["comment", "check"]).default("comment"),
  max_scenarios: z.number().int().min(1).max(20).default(8),
  /**
   * Facts the browser agent needs that are not in the ticket: test accounts,
   * seed data, feature flags. Never put real passwords here — use auth + env.
   */
  agent_notes: z.string().optional(),
  /**
   * Origins besides the app under test that the browser may navigate to,
   * e.g. an SSO login page ("https://login.example.com"). Everything else is blocked.
   */
  allowed_origins: z.array(z.string().url()).default([]),
});

export type ExhibitConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown, source = ".exhibit.yml"): ExhibitConfig {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(`Invalid ${source}:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Loads `.exhibit.yml` from `dir`. A missing file yields the defaults. */
export async function loadConfig(dir = process.cwd()): Promise<ExhibitConfig> {
  // .gate.yml: the working name before "Exhibit"; still read so early setups keep working.
  let path = "";
  let text: string | undefined;
  for (const name of [".exhibit.yml", ".exhibit.yaml", ".gate.yml"]) {
    path = join(dir, name);
    try {
      text = await readFile(path, "utf8");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (text === undefined) return parseConfig({});
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid YAML: ${(e as Error).message}`);
  }
  return parseConfig(raw, path);
}
