import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { LANGUAGE_PATTERN } from "./language.js";

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
  /**
   * Language of the review, the scenarios and the findings. "auto" follows the
   * ticket; a name or code ("pl", "Polish", "Deutsch") fixes it. The fixed words
   * of the report exist in English and Polish.
   */
  language: z
    .string()
    .trim()
    .regex(LANGUAGE_PATTERN, { message: 'language must be "auto" or a language name or code, e.g. pl, Polish, Deutsch' })
    .default("auto"),
  /**
   * Extra headings that start the acceptance criteria section of a ticket,
   * besides "Acceptance Criteria" / "Kryteria akceptacji", e.g. "Akzeptanzkriterien".
   */
  acceptance_headings: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  preview_url: z.string().optional(),
  model: z
    .object({
      provider: z.enum(["anthropic", "openai"]).default("anthropic"),
      name: z.string().optional(),
      max_cost_per_run_usd: z.number().positive().default(1.5),
      /** Seconds to wait for one answer from the model. Generous: a reasoning model may think for minutes. */
      call_timeout_s: z.number().int().positive().default(180),
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
  /** Seconds one browser scenario may take before it is stopped and reported as blocked. */
  scenario_timeout_s: z.number().int().positive().default(600),
  /** Generated tests. */
  tests: z
    .object({
      /**
       * Folder in the repository where `/accept-tests` commits the generated test file.
       * A plain relative path: it cannot leave the repository or point into .github.
       */
      dir: z
        .string()
        .trim()
        .regex(/^(?!\/)(?!\.github(\/|$))(?!.*\.\.)[A-Za-z0-9._\/-]{1,120}$/, {
          message: "tests.dir must be a folder inside the repository, e.g. tests/exhibit (no leading /, no .., not .github)",
        })
        .transform((d) => d.replace(/\/+$/, ""))
        .default("tests/exhibit"),
    })
    .prefault({}),
  /**
   * Facts about the test environment that are not in the ticket: test accounts,
   * seed data, feature flags, things that must not be touched. Given to the
   * review, the planner and the browser agent. Never put real passwords here —
   * use auth + env.
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
