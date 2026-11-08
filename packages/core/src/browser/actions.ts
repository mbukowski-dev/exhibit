import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { Secrets } from "./secrets.js";

/**
 * One flat object instead of a union: structured-output support for unions
 * differs between providers, a flat schema works everywhere.
 */
export const AgentActionSchema = z.object({
  thought: z.string().describe("One sentence: what you see and why this action"),
  action: z.enum(["click", "fill", "select", "check", "press", "goto", "wait", "assert", "done"]),
  role: z
    .string()
    .optional()
    .describe("ARIA role of the target from the snapshot, e.g. button, link, textbox, checkbox, combobox, heading"),
  name: z.string().optional().describe("Accessible name of the target exactly as in the snapshot"),
  value: z
    .string()
    .optional()
    .describe("fill: text to type (use {{secret}} placeholders for credentials); select: option label; press: key such as Enter; goto: relative path; assert: text that must be visible"),
  // Plain string, not an enum: some providers fill unused fields with "" which an enum rejects.
  verdict: z.string().optional().describe('done only: "pass" = all expected results observed; "fail" = app behaved wrong; "blocked" = could not get to the point of checking'),
  reason: z.string().optional().describe("done only: what you observed, citing visible text"),
});

type RawAgentAction = z.infer<typeof AgentActionSchema>;
export type AgentAction = Omit<RawAgentAction, "verdict"> & { verdict?: "pass" | "fail" | "blocked" };

/** Empty strings and nulls from the model mean "not set". */
export function normalizeAction(raw: RawAgentAction): AgentAction {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const verdict = clean(raw.verdict)?.toLowerCase();
  return {
    thought: raw.thought ?? "",
    action: raw.action,
    role: clean(raw.role),
    name: clean(raw.name),
    value: clean(raw.value),
    reason: clean(raw.reason),
    verdict: verdict === "pass" || verdict === "fail" || verdict === "blocked" ? verdict : undefined,
  };
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Playwright code equivalent of this step, for codegen (E5-1). */
  code?: string;
}

const q = (s: string) => JSON.stringify(s);

interface Target {
  locator: Locator;
  /** Playwright code for the selector that matches — call while the element is on the page. */
  code: () => Promise<string>;
}

/**
 * Role + accessible name first; if nothing has that name, the same role
 * whose text contains it. Needed because for roles like status, alert or
 * paragraph the visible text is NOT the accessible name, while the snapshot
 * shows it right after the role (self-test run 2: 15 failed asserts on
 * `status "Check your inbox"` that was on screen).
 */
function target(page: Page, a: AgentAction): Target {
  if (!a.name && !a.role) throw new Error(`"${a.action}" needs a role and/or name from the snapshot`);
  if (!a.role) {
    const code = `page.getByText(${q(a.name!)}, { exact: true })`;
    return { locator: page.getByText(a.name!, { exact: true }), code: async () => code };
  }
  const role = a.role as Parameters<Page["getByRole"]>[0];
  if (!a.name) {
    const code = `page.getByRole(${q(a.role)})`;
    return { locator: page.getByRole(role), code: async () => code };
  }
  const byName = page.getByRole(role, { name: a.name, exact: true });
  const byText = page.getByRole(role).filter({ hasText: a.name });
  const byNameCode = `page.getByRole(${q(a.role)}, { name: ${q(a.name)}, exact: true })`;
  const byTextCode = `page.getByRole(${q(a.role)}).filter({ hasText: ${q(a.name)} })`;
  return {
    locator: byName.or(byText),
    code: async () => ((await byName.count().catch(() => 0)) > 0 ? byNameCode : byTextCode),
  };
}

/** Waits until the target is visible, then returns the code of the selector that matched. */
async function settle(t: Target, timeout: number): Promise<string> {
  await t.locator.first().waitFor({ state: "visible", timeout });
  return t.code();
}

/** Executes one agent action. Never throws: errors go back to the agent as feedback. */
export async function executeAction(
  page: Page,
  a: AgentAction,
  ctx: { baseUrl: string; secrets: Secrets; timeoutMs?: number; canTypeSecretsAt?: (url: string) => boolean },
): Promise<ActionResult> {
  const timeout = ctx.timeoutMs ?? 7_000;
  try {
    switch (a.action) {
      case "goto": {
        const path = a.value ?? "/";
        const url = new URL(path, ctx.baseUrl);
        if (url.origin !== new URL(ctx.baseUrl).origin) {
          return { ok: false, error: `Navigation outside the app under test is not allowed (${url.origin})` };
        }
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        return { ok: true, code: `await page.goto(${q(url.pathname + url.search)});` };
      }
      case "click": {
        const t = target(page, a);
        const code = await settle(t, timeout);
        await t.locator.first().click({ timeout });
        return { ok: true, code: `await ${code}.click();` };
      }
      case "fill": {
        const t = target(page, a);
        const raw = a.value ?? "";
        // Credentials are only ever typed into the app under test (or an allowed SSO origin).
        if (ctx.secrets.unknownPlaceholders(raw).length === 0 && /\{\{\w+\}\}/.test(raw) && ctx.canTypeSecretsAt && !ctx.canTypeSecretsAt(page.url())) {
          return { ok: false, error: `Refused to type credentials on ${new URL(page.url()).origin}: it is outside the app under test.` };
        }
        const unknown = ctx.secrets.unknownPlaceholders(raw);
        if (unknown.length) {
          const have = ctx.secrets.names.length ? ctx.secrets.names.map((n) => `{{${n}}}`).join(", ") : "none";
          return { ok: false, error: `No secret named ${unknown.map((n) => `{{${n}}}`).join(", ")} (available: ${have}). Use test data from the notes or the ticket instead.` };
        }
        const code = await settle(t, timeout);
        await t.locator.first().fill(ctx.secrets.substitute(raw), { timeout });
        // Generated tests read secrets from env, never inline them.
        const valueCode = /\{\{(\w+)\}\}/.test(raw)
          ? raw.replace(/^\{\{(\w+)\}\}$/, (_, n: string) => `process.env.EXHIBIT_${n.toUpperCase()}!`)
          : q(raw);
        return { ok: true, code: `await ${code}.fill(${valueCode});` };
      }
      case "select": {
        const t = target(page, a);
        const code = await settle(t, timeout);
        await t.locator.first().selectOption({ label: a.value ?? "" }, { timeout });
        return { ok: true, code: `await ${code}.selectOption({ label: ${q(a.value ?? "")} });` };
      }
      case "check": {
        const t = target(page, a);
        const code = await settle(t, timeout);
        await t.locator.first().check({ timeout });
        return { ok: true, code: `await ${code}.check();` };
      }
      case "press": {
        await page.keyboard.press(a.value ?? "Enter");
        return { ok: true, code: `await page.keyboard.press(${q(a.value ?? "Enter")});` };
      }
      case "wait": {
        await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
        return { ok: true };
      }
      case "assert": {
        const text = a.value ?? a.name ?? "";
        const loc: Target = a.role ? target(page, a) : { locator: page.getByText(text), code: async () => `page.getByText(${q(text)})` };
        const code = await settle(loc, timeout);
        return { ok: true, code: `await expect(${code}.first()).toBeVisible();` };
      }
      case "done":
        return { ok: true };
    }
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0] ?? "action failed";
    return { ok: false, error: ctx.secrets.redact(msg) };
  }
}
