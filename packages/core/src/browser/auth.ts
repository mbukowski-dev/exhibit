import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import type { ExhibitConfig } from "../config.js";
import { Secrets } from "./secrets.js";

export type LoginFn = (page: Page, secrets: Secrets) => Promise<void>;

export interface RoleAuth {
  secrets: Secrets;
  /** Present when the project provides its own login script. */
  login?: LoginFn;
}

/**
 * E4-3: credentials come from env vars named in .exhibit.yml (GitHub Secrets in CI).
 * Two modes per role:
 *  - `login_flow: ./e2e/login.ts` — a module whose default export logs in
 *    `(page, { username, password }) => Promise<void>`; most reliable.
 *  - only username_env/password_env — the agent logs in itself using
 *    {{username}} / {{password}} placeholders.
 */
export async function resolveRoleAuth(
  config: ExhibitConfig,
  role: string,
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RoleAuth> {
  const entry = config.auth.find((a) => a.role === role) ?? (role === "anonymous" ? undefined : config.auth[0]);
  if (!entry) return { secrets: new Secrets() };

  const values: Record<string, string | undefined> = {};
  if (entry.username_env) values.username = env[entry.username_env];
  if (entry.password_env) values.password = env[entry.password_env];
  for (const [name, envName] of [["username", entry.username_env], ["password", entry.password_env]] as const) {
    if (envName && !env[envName]) throw new Error(`auth role "${entry.role}": env var ${envName} (${name}) is not set`);
  }
  const secrets = new Secrets(values);

  if (!entry.login_flow) return { secrets };
  const mod = await import(pathToFileURL(resolve(repoDir, entry.login_flow)).href);
  const fn = (mod.default ?? mod.login) as unknown;
  if (typeof fn !== "function") {
    throw new Error(`${entry.login_flow} must export a default async function (page, credentials) => void`);
  }
  return {
    secrets,
    login: (page) => (fn as (p: Page, c: Record<string, string | undefined>) => Promise<void>)(page, values),
  };
}
