import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { Secrets } from "./secrets.js";

/**
 * One flat object instead of a union: structured-output support for unions
 * differs between providers, a flat schema works everywhere.
 */
export const AgentActionSchema = z.object({
  thought: z.string().describe("One sentence: what you see and why this action"),
  action: z.enum(["click", "fill", "select", "check", "press", "goto", "wait", "assert", "assert_absent", "done"]),
  role: z
    .string()
    .optional()
    .describe("ARIA role of the target from the snapshot, e.g. button, link, textbox, checkbox, combobox, heading"),
  name: z.string().optional().describe("Accessible name of the target exactly as in the snapshot"),
  value: z
    .string()
    .optional()
    .describe(
      "fill: text to type (use {{secret}} placeholders for credentials); select: option label; press: key such as Enter; goto: relative path; " +
        "assert: the complete visible text of one element, as the snapshot shows it; assert_absent: text that must NOT be visible",
    ),
  // Coerced: providers fill an unused number with 0, "" or null; anything that is not 1, 2, 3… means "not set".
  expects: z.coerce
    .number()
    .optional()
    .describe("assert / assert_absent only: the number of the expected result this checks, from the scenario's Expected list (1, 2, …)"),
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
    expects: typeof raw.expects === "number" && Number.isInteger(raw.expects) && raw.expects > 0 ? raw.expects : undefined,
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

/** A fragment shorter than this many words must be the whole text of an element to count as evidence. */
const MIN_FRAGMENT_WORDS = 4;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max = 160) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

interface SeenText {
  /** Everything the element shows. */
  full: string;
  /** Its own pieces of text, without child elements ("Invoice 7" in a list item that also holds a button). */
  own: string[];
}

/** Texts of the visible elements a locator matches; a few are enough to judge and to report. */
async function visibleTexts(loc: Locator, max = 5): Promise<SeenText[]> {
  const out: SeenText[] = [];
  const n = Math.min(await loc.count().catch(() => 0), 25);
  for (let i = 0; i < n && out.length < max; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = await el
      .evaluate((e) => ({
        full: (e as HTMLElement).innerText ?? e.textContent ?? "",
        own: [...e.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent ?? ""),
      }))
      .catch(() => undefined);
    if (t) out.push({ full: squash(t.full), own: t.own.map(squash).filter(Boolean) });
  }
  return out;
}

const listTexts = (seen: SeenText[]) => [...new Set(seen.map((s) => s.full).filter(Boolean))].slice(0, 3).map((s) => q(clip(s))).join(", ");

/**
 * An assert is evidence only if it cannot match by coincidence: "account found"
 * is on a page that says "No account found for this email", and "Saved" is in
 * "Saved searches". So the text must be the whole text of an element (letter
 * case and spacing aside) or a fragment of at least MIN_FRAGMENT_WORDS words.
 * Returns what to tell the agent, or undefined when the match is fine.
 */
export function fragmentProblem(text: string, seen: SeenText[]): string | undefined {
  const want = squash(text).toLowerCase();
  if (want.split(" ").length >= MIN_FRAGMENT_WORDS) return undefined;
  if (seen.some((s) => s.full.toLowerCase() === want || s.own.some((o) => o.toLowerCase() === want))) return undefined;
  return (
    `${q(text)} is only a fragment of what the page shows: ${listTexts(seen)}. A short fragment can match by coincidence. ` +
    `Assert the complete text of the element you mean (or at least ${MIN_FRAGMENT_WORDS} consecutive words of it), and check it says what the scenario expects.`
  );
}

const visibleOnly = (loc: Locator) => loc.locator("visible=true");

/** "assert": the text (or the role + name) is visible, and the match is specific enough to be evidence. */
async function assertVisible(page: Page, a: AgentAction, timeout: number): Promise<ActionResult> {
  const shown = (code: string): ActionResult => ({ ok: true, code: `await expect(${code}.first()).toBeVisible();` });
  if (a.role) {
    // A role with only a value used to match ANY element of that role.
    const name = a.name ?? a.value;
    const t = target(page, { ...a, name });
    const code = await settle(t, timeout);
    if (!name) return shown(code);
    const role = a.role as Parameters<Page["getByRole"]>[0];
    if ((await page.getByRole(role, { name, exact: true }).count().catch(() => 0)) > 0) return shown(code);
    const problem = fragmentProblem(name, await visibleTexts(page.getByRole(role).filter({ hasText: name })));
    return problem ? { ok: false, error: problem } : shown(code);
  }
  const text = a.value ?? a.name ?? "";
  // getByText("") matches every element: an assert without text would always pass.
  if (!text.trim()) return { ok: false, error: '"assert" needs the text that must be visible (value), or a role and name' };
  const loose = page.getByText(text);
  await loose.first().waitFor({ state: "visible", timeout });
  if ((await visibleOnly(page.getByText(text, { exact: true })).count().catch(() => 0)) > 0) {
    return shown(`page.getByText(${q(text)}, { exact: true })`);
  }
  const problem = fragmentProblem(text, await visibleTexts(loose));
  return problem ? { ok: false, error: problem } : shown(`page.getByText(${q(text)})`);
}

/**
 * "assert_absent": nothing visible matches. Matching is deliberately loose
 * (any element containing the text counts as present) — for "must NOT be
 * shown" that is the strict direction.
 */
async function assertAbsent(page: Page, a: AgentAction, timeout: number): Promise<ActionResult> {
  const text = a.role ? a.name ?? a.value : a.value ?? a.name;
  if (!a.role && !text?.trim()) return { ok: false, error: '"assert_absent" needs the text that must not be visible (value), or a role and name' };
  let locator: Locator;
  let code: string;
  if (!a.role) {
    locator = page.getByText(text!);
    code = `page.getByText(${q(text!)})`;
  } else {
    locator = target(page, { ...a, name: text }).locator;
    code = text
      ? `page.getByRole(${q(a.role)}, { name: ${q(text)}, exact: true }).or(page.getByRole(${q(a.role)}).filter({ hasText: ${q(text)} }))`
      : `page.getByRole(${q(a.role)})`;
  }
  // Something on its way out (a spinner, a toast) gets a moment to go.
  await visibleOnly(locator).first().waitFor({ state: "hidden", timeout: Math.min(timeout, 3_000) }).catch(() => {});
  const seen = await visibleTexts(locator, 3);
  if (seen.length) {
    const what = [a.role, text && q(text)].filter(Boolean).join(" ");
    const texts = listTexts(seen);
    return { ok: false, error: `${what} is visible on the page${texts ? `: ${texts}` : ""}.` };
  }
  return { ok: true, code: `await expect(${code}.locator("visible=true")).toHaveCount(0);` };
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
      case "assert":
      case "assert_absent": {
        const r = await (a.action === "assert" ? assertVisible(page, a, timeout) : assertAbsent(page, a, timeout));
        // The error quotes the page, which may show what was typed into it.
        return r.error ? { ...r, error: ctx.secrets.redact(r.error) } : r;
      }
      case "done":
        return { ok: true };
    }
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0] ?? "action failed";
    return { ok: false, error: ctx.secrets.redact(msg) };
  }
}
