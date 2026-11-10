import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { chromium, type Browser, type Page } from "playwright";
import { runScenario, type StepRecord } from "../src/browser/agent.js";
import { executeAction, normalizeAction, type AgentAction } from "../src/browser/actions.js";
import { checkPassEvidence } from "../src/browser/nudges.js";
import { Secrets } from "../src/browser/secrets.js";
import type { Scenario } from "../src/plan.js";

const PAGE = `<!doctype html><html lang="en"><head><title>Reset password</title></head><body>
<h1>Reset password</h1>
<p role="alert">No account found for this email</p>
<ul><li>Invoice 7 <button>Delete</button></li></ul>
<p>Your password must be at least twelve characters long and contain a digit.</p>
<p style="display:none">Internal note</p>
</body></html>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(baseUrl);
  dir = await mkdtemp(join(tmpdir(), "exhibit-assert-"));
});
afterAll(async () => {
  await browser.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (a: Partial<AgentAction>) =>
  executeAction(page, { thought: "", action: "assert", ...a } as AgentAction, { baseUrl, secrets: new Secrets(), timeoutMs: 1_500 });

describe("assert: a short fragment is not evidence (E12-3)", () => {
  it("rejects a fragment of a longer text and shows what the page really says", async () => {
    // Seen in a probe: "account found" used to pass on a page saying "No account found for this email".
    const r = await run({ value: "account found" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No account found for this email");
  });

  it("accepts the complete text of an element, and generates an exact check", async () => {
    const r = await run({ value: "No account found for this email" });
    expect(r).toEqual({ ok: true, code: 'await expect(page.getByText("No account found for this email", { exact: true }).first()).toBeVisible();' });
  });

  it("is not picky about letter case or spacing", async () => {
    expect((await run({ value: "no account found  for this email" })).ok).toBe(true);
  });

  it("accepts an element's own text when the element also holds a button", async () => {
    expect((await run({ value: "Invoice 7" })).ok).toBe(true);
  });

  it("accepts a fragment of four or more words of a long text", async () => {
    const r = await run({ value: "at least twelve characters long" });
    expect(r).toEqual({ ok: true, code: 'await expect(page.getByText("at least twelve characters long").first()).toBeVisible();' });
  });

  it("applies the same rule when a role is given", async () => {
    const weak = await run({ role: "alert", name: "account found" });
    expect(weak.ok).toBe(false);
    expect(weak.error).toContain("No account found for this email");
    expect((await run({ role: "alert", name: "No account found for this email" })).ok).toBe(true);
    expect((await run({ role: "button", name: "Delete" })).ok).toBe(true); // exact accessible name
  });

  it("checks the text when a role comes with a value instead of a name", async () => {
    // Used to match ANY element of that role.
    expect((await run({ role: "alert", value: "Check your inbox" })).ok).toBe(false);
    expect((await run({ role: "alert", value: "No account found for this email" })).ok).toBe(true);
  });

  it("still reports text that is not on the page at all", async () => {
    const r = await run({ value: "Check your inbox" });
    expect(r.ok).toBe(false);
  });
});

describe("assert_absent: proving something is NOT shown (E12-3)", () => {
  const absent = (a: Partial<AgentAction>) => run({ action: "assert_absent", ...a });

  it("passes when the text is nowhere on the page", async () => {
    const r = await absent({ value: "Check your inbox" });
    expect(r).toEqual({ ok: true, code: 'await expect(page.getByText("Check your inbox").locator("visible=true")).toHaveCount(0);' });
  });

  it("fails when the text is visible — even as part of a longer text", async () => {
    const r = await absent({ value: "account found" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is visible/);
    expect(r.error).toContain("No account found for this email");
  });

  it("treats text that is in the page but hidden as absent", async () => {
    expect((await absent({ value: "Internal note" })).ok).toBe(true);
  });

  it("works with a role", async () => {
    expect((await absent({ role: "button", name: "Delete" })).ok).toBe(false);
    expect((await absent({ role: "button", name: "Archive" })).ok).toBe(true);
  });

  it("needs something to look for", async () => {
    expect((await absent({})).ok).toBe(false);
  });
});

describe('"expects": which expected result an assert checks (E12-4)', () => {
  it("reads the number however the model writes it", () => {
    const n = (expects: unknown) => normalizeAction({ thought: "", action: "assert", expects } as any).expects;
    expect(n(2)).toBe(2);
    expect(n(0)).toBeUndefined(); // providers fill unused numbers with 0
    expect(n(undefined)).toBeUndefined();
    expect(n(-1)).toBeUndefined();
    expect(n(1.5)).toBeUndefined();
  });

  let k = 0;
  const st = (action: string, extra: Partial<AgentAction> = {}, ok = true): StepRecord => ({
    n: ++k, ok, url: "/", action: { thought: "", action: action as AgentAction["action"], ...extra },
  });
  const three = ["Message A is shown", "Total is 30", "No error is shown"];

  it("rejects a pass backed by one assert when three results were expected", () => {
    const m = checkPassEvidence([st("click"), st("assert", { value: "Reset password" })], three)?.message;
    expect(m).toMatch(/1\. Message A is shown[\s\S]*2\. Total is 30[\s\S]*3\. No error is shown/);
    expect(m).toContain('"expects"');
  });

  it("names only the results that are still unchecked", () => {
    const m = checkPassEvidence([st("click"), st("assert", { expects: 1 }), st("assert", { expects: 2 })], three)?.message;
    expect(m).toContain("3. No error is shown");
    expect(m).not.toContain("1. Message A is shown");
  });

  it("accepts a pass when every expected result has its own successful assert", () => {
    const steps = [st("click"), st("assert", { expects: 1 }), st("assert", { expects: 2 }), st("assert_absent", { expects: 3 })];
    expect(checkPassEvidence(steps, three)).toBeUndefined();
  });

  it("does not count failed asserts or numbers outside the list", () => {
    const steps = [st("click"), st("assert", { expects: 1 }), st("assert", { expects: 2 }, false), st("assert", { expects: 7 }), st("assert", { expects: 3 })];
    expect(checkPassEvidence(steps, three)?.message).toContain("2. Total is 30");
  });

  it("counts results checked earlier in the flow, before a later action", () => {
    // Expected 1 is visible before submitting, expected 2 after: both are verified.
    const steps = [st("assert", { expects: 1 }), st("click"), st("assert", { expects: 2 })];
    expect(checkPassEvidence(steps, ["Form shows the hint", "Saved is shown"])).toBeUndefined();
  });

  it("still needs the page to be checked after the last action", () => {
    const steps = [st("assert", { expects: 1 }), st("assert", { expects: 2 }), st("click")];
    expect(checkPassEvidence(steps, ["A", "B"])?.message).toMatch(/after your last action/);
  });

  it("does not let 'nothing there' stand alone: assert_absent counts only after an assert on the same page", () => {
    // Right after a click nothing has rendered yet, so "the error is absent" would be trivially true.
    const early = [st("click"), st("assert_absent", { expects: 2 }), st("assert", { expects: 1 })];
    expect(checkPassEvidence(early, ["Saved is shown", "No error is shown"])?.message).toContain("2. No error is shown");
    const anchored = [st("click"), st("assert", { expects: 1 }), st("assert_absent", { expects: 2 })];
    expect(checkPassEvidence(anchored, ["Saved is shown", "No error is shown"])).toBeUndefined();
    // …and never as the only evidence.
    expect(checkPassEvidence([st("click"), st("assert_absent")], ["No error is shown"])).toBeDefined();
  });

  it("keeps a single expected result simple: one assert, no number needed", () => {
    expect(checkPassEvidence([st("click"), st("assert")], ["Saved is shown"])).toBeUndefined();
  });
});

describe("agent run with several expected results (E12-4)", () => {
  function scripted(actions: Partial<AgentAction>[]) {
    let i = 0;
    return new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ thought: "scripted", ...actions[Math.min(i++, actions.length - 1)] }) }],
        finishReason: "stop",
        usage: { inputTokens: 2000, outputTokens: 50, totalTokens: 2050 },
        warnings: [],
      }),
    });
  }
  const scenario: Scenario = {
    id: "S1", title: "Unknown email", acIds: ["AC3"], priority: "p1", role: "anonymous", startPath: "/",
    steps: ["Open the page"], expected: ["The heading 'Reset password' is shown", "'Check your inbox' is NOT shown"],
  };

  it("pushes back on a pass that checked one of two results, then accepts it", async () => {
    const model = scripted([
      { action: "assert", role: "heading", name: "Reset password", expects: 1 },
      { action: "done", verdict: "pass", reason: "Heading is there" }, // expected 2 never checked → rejected
      { action: "assert_absent", value: "Check your inbox", expects: 2 },
      { action: "done", verdict: "pass", reason: "Heading shown, no 'Check your inbox'" },
    ]);
    const r = await runScenario(scenario, { baseUrl, model, artifactsDir: dir });

    expect(r.verdict).toBe("pass");
    expect(r.nudges.map((n) => n.kind)).toEqual(["unverified_pass"]);
    expect(r.nudges[0]!.message).toContain("2. 'Check your inbox' is NOT shown");
    expect(r.steps.map((s) => s.code).filter(Boolean)).toEqual([
      'await expect(page.getByRole("heading", { name: "Reset password", exact: true }).first()).toBeVisible();',
      'await expect(page.getByText("Check your inbox").locator("visible=true")).toHaveCount(0);',
    ]);
    // The agent is told the numbers it has to use, and sees which result each assert covered.
    const lastPrompt = JSON.stringify(model.doGenerateCalls[3]!.prompt);
    expect(lastPrompt).toContain("1. The heading 'Reset password' is shown");
    expect(lastPrompt).toContain("(expected result 2)");
  }, 30_000);
});
