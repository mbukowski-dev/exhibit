import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
// @ts-expect-error — plain JS demo app
import { createApp } from "../../../examples/demo-app/server.mjs";
import { runScenario, runScenarios } from "../src/browser/agent.js";
import { Secrets } from "../src/browser/secrets.js";
import { expandPreviewUrl, waitForUrl } from "../src/browser/ready.js";
import { judge } from "../src/verdict.js";
import { UsageMeter } from "../src/usage.js";
import { normalizeAction, type AgentAction } from "../src/browser/actions.js";
import type { Scenario } from "../src/plan.js";

/** A model that plays back a fixed list of actions, one per call. */
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

const scenario = (id: string, acIds: string[], extra: Partial<Scenario> = {}): Scenario => ({
  id, title: id, acIds, priority: "p1", role: "anonymous", startPath: "/login",
  steps: ["…"], expected: ["…"], ...extra,
});

let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-test-"));
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("browser agent (E4-1, E4-2, E4-4)", () => {
  it("passes a scenario, records steps as Playwright code and saves evidence", async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "ana@example.com" },
      { action: "click", role: "button", name: "Send reset link" },
      { action: "assert", value: "Check your inbox" },
      { action: "done", verdict: "pass", reason: "Saw 'Check your inbox'" },
    ]);
    const meter = new UsageMeter("claude-opus-5-5");
    const r = await runScenario(scenario("S1", ["AC2"]), { baseUrl, model, artifactsDir: dir, meter });

    expect(r.verdict).toBe("pass");
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.steps.map((s) => s.code).filter(Boolean)).toEqual([
      'await page.getByRole("link", { name: "Forgot password?", exact: true }).click();',
      'await page.getByRole("textbox", { name: "Email", exact: true }).fill("ana@example.com");',
      'await page.getByRole("button", { name: "Send reset link", exact: true }).click();',
      'await expect(page.getByText("Check your inbox").first()).toBeVisible();',
    ]);
    expect(meter.steps).toHaveLength(5);
    for (const f of [r.artifacts.video, r.artifacts.trace, r.artifacts.screenshot]) {
      expect(f && (await stat(f)).size).toBeGreaterThan(0);
    }
    // The model saw the page as an accessibility tree.
    const firstPrompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(firstPrompt).toContain('link \\"Forgot password?\\"');
  }, 30_000);

  it("reports a failing action back to the model instead of crashing", async () => {
    const model = scripted([
      { action: "click", role: "button", name: "Does not exist" },
      { action: "done", verdict: "blocked", reason: "no such button" },
    ]);
    const r = await runScenario(scenario("S2", ["AC1"]), { baseUrl, model, artifactsDir: dir, actionTimeoutMs: 500 });
    expect(r.steps[0]!.ok).toBe(false);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("FAILED");
    expect(r.verdict).toBe("blocked");
  }, 30_000);

  it("stops at the step limit", async () => {
    const model = scripted([{ action: "wait" }]);
    const r = await runScenario(scenario("S3", ["AC1"]), { baseUrl, model, artifactsDir: dir, maxSteps: 3 });
    expect(r.steps).toHaveLength(3);
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toMatch(/Step limit/);
  }, 30_000);

  it("refuses navigation outside the app", async () => {
    const model = scripted([{ action: "goto", value: "https://evil.example.com/" }, { action: "done", verdict: "blocked", reason: "x" }]);
    const r = await runScenario(scenario("S4", []), { baseUrl, model, artifactsDir: dir });
    expect(r.steps[0]!.error).toMatch(/outside the app/);
  }, 30_000);
});

describe("supervisor nudges (E11-1, E11-2)", () => {
  it("rejects a pass that was not verified, then accepts it after an assert", async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "done", verdict: "pass", reason: "looks fine" }, // no assert → rejected
      { action: "assert", role: "button", name: "Send reset link" },
      { action: "done", verdict: "pass", reason: "Reset form shown" },
    ]);
    const r = await runScenario(scenario("N1", ["AC1"], { expected: ["Reset form is shown"] }), { baseUrl, model, artifactsDir: dir });
    expect(r.verdict).toBe("pass");
    expect(r.nudges.map((x) => x.kind)).toEqual(["unverified_pass"]);
    const third = JSON.stringify(model.doGenerateCalls[2]!.prompt);
    expect(third).toContain("exhibit_notice");
    expect(third).toContain("Reset form is shown");
    expect(r.steps[1]).toMatchObject({ ok: false, error: "pass rejected: expected results not verified" });
  }, 30_000);

  it("turns a stubborn unverified pass into blocked", async () => {
    const model = scripted([{ action: "done", verdict: "pass", reason: "trust me" }]);
    const r = await runScenario(scenario("N2", ["AC1"]), { baseUrl, model, artifactsDir: dir });
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toMatch(/without verifying/);
    expect(model.doGenerateCalls).toHaveLength(3);
  }, 30_000);

  it("nudges a loop of failing actions once", async () => {
    const model = scripted([
      { action: "click", role: "button", name: "Nope" },
      { action: "click", role: "button", name: "Nope" },
      { action: "done", verdict: "blocked", reason: "no button" },
    ]);
    const r = await runScenario(scenario("N3", ["AC1"]), { baseUrl, model, artifactsDir: dir, actionTimeoutMs: 300 });
    expect(r.nudges.map((x) => x.kind)).toEqual(["loop"]);
    expect(JSON.stringify(model.doGenerateCalls[2]!.prompt)).toContain("failed twice");
  }, 30_000);
});

describe("secrets (E4-3)", () => {
  it("types real values but never shows them to the model", async () => {
    const secrets = new Secrets({ username: "ana@example.com" });
    const model = scripted([
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "{{username}}" },
      { action: "click", role: "button", name: "Send reset link" },
      { action: "assert", value: "Check your inbox" },
      { action: "done", verdict: "pass", reason: "ok" },
    ]);
    const r = await runScenario(scenario("S5", ["AC2"]), { baseUrl, model, artifactsDir: dir, secrets });
    expect(r.steps[1]!.code).toContain("process.env.EXHIBIT_USERNAME!");
    const prompts = JSON.stringify(model.doGenerateCalls.map((c) => c.prompt));
    expect(prompts).not.toContain("ana@example.com");
    expect(prompts).toContain("{{username}}");
  }, 30_000);

  it("redacts and substitutes", () => {
    const s = new Secrets({ password: "hunter22", username: "ana" });
    expect(s.substitute("{{username}}:{{password}}")).toBe("ana:hunter22");
    expect(s.redact("ana typed hunter22")).toBe("{{username}} typed {{password}}");
  });
});

describe("end to end: catches the AC3 bug (E6-1)", () => {
  it("passes AC2, fails AC3, leaves the untestable AC4 unverified", async () => {
    const criteria = [
      { id: "AC2", text: "Registered email shows 'Check your inbox'", source: "section" as const },
      { id: "AC3", text: "Unknown email shows the same message", source: "section" as const },
      { id: "AC4", text: "Link expires after 30 minutes", source: "section" as const },
    ];
    const model = scripted([
      // S1 (AC2)
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "ana@example.com" },
      { action: "click", role: "button", name: "Send reset link" },
      { action: "assert", value: "Check your inbox" },
      { action: "done", verdict: "pass", reason: "Saw 'Check your inbox'" },
      // S2 (AC3)
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "nobody@example.com" },
      { action: "click", role: "button", name: "Send reset link" },
      { action: "done", verdict: "fail", reason: "Shows 'No account found for this email' instead of 'Check your inbox'" },
    ]);
    const results = await runScenarios(
      [
        scenario("S1", ["AC2"]),
        scenario("S2", ["AC3"]),
        scenario("S3", ["AC4"], { notTestableInBrowser: "needs waiting 30 minutes" }),
      ],
      { baseUrl, model, artifactsDir: dir },
    );
    const v = judge(criteria, { coverage: [], risks: [] }, results);
    expect(v.criteria.map((c) => [c.acId, c.verdict])).toEqual([["AC2", "pass"], ["AC3", "fail"], ["AC4", "unverified"]]);
    expect(v.overall).toBe("fail");
    expect(v.criteria[1]!.summary).toContain("No account found");
  }, 60_000);
});

describe("preview URL (E4-5)", () => {
  it("waits until the app answers", async () => {
    await expect(waitForUrl(baseUrl, { timeoutMs: 2000 })).resolves.toBeUndefined();
    await expect(waitForUrl("http://127.0.0.1:1/", { timeoutMs: 300, intervalMs: 100 })).rejects.toThrow(/not ready/);
  });
  it("expands templates", () => {
    expect(expandPreviewUrl("https://pr-{pr}.app.dev", { pr: 42 })).toBe("https://pr-42.app.dev");
    expect(expandPreviewUrl("https://{branch}.app.dev", { branch: "feature/PROJ-1_x" })).toBe("https://feature-proj-1-x.app.dev");
  });
});

describe("lessons from the first real run (gpt-5)", () => {
  it('treats "" from the model as "not set" (verdict: "" used to kill the scenario)', () => {
    const a = normalizeAction({ thought: "t", action: "click", role: "link", name: "Forgot password?", value: "", verdict: "", reason: "" } as any);
    expect(a).toEqual({ thought: "t", action: "click", role: "link", name: "Forgot password?", value: undefined, verdict: undefined, reason: undefined });
    expect(normalizeAction({ thought: "", action: "done", verdict: "PASS" } as any).verdict).toBe("pass");
  });

  it("retries once when the answer does not match the schema", async () => {
    let i = 0;
    const answers = ["not json at all", JSON.stringify({ thought: "x", action: "assert", value: "Sign in" }), JSON.stringify({ thought: "x", action: "done", verdict: "pass", reason: "ok" })];
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({ content: [{ type: "text", text: answers[Math.min(i++, 2)]! }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
    });
    const r = await runScenario(scenario("L1", ["AC1"]), { baseUrl, model, artifactsDir: dir });
    expect(r.verdict).toBe("pass");
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("not valid for the action schema");
  }, 30_000);

  it("refuses to type an unknown {{placeholder}} and says why", async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "{{username}}" },
      { action: "done", verdict: "blocked", reason: "x" },
    ]);
    const r = await runScenario(scenario("L2", ["AC2"]), { baseUrl, model, artifactsDir: dir });
    expect(r.steps[1]).toMatchObject({ ok: false });
    expect(r.steps[1]!.error).toMatch(/No secret named \{\{username\}\} \(available: none\)/);
  }, 30_000);

  it("gives the agent the test-data notes and asks for low reasoning effort", async () => {
    const model = scripted([{ action: "done", verdict: "blocked", reason: "x" }]);
    await runScenario(scenario("L3", ["AC2"]), { baseUrl, model, artifactsDir: dir, notes: "Registered account: ana@example.com" });
    const call = model.doGenerateCalls[0]!;
    expect(JSON.stringify(call.prompt)).toContain("Registered account: ana@example.com");
    expect(call.providerOptions).toMatchObject({ openai: { reasoningEffort: "low" }, anthropic: { effort: "low" } });
  }, 30_000);
});

describe("lessons from self-test run 2", () => {
  it('finds a status message by its text (role "status" has no name from content)', async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Forgot password?" },
      { action: "fill", role: "textbox", name: "Email", value: "ana@example.com" },
      { action: "click", role: "button", name: "Send reset link" },
      { action: "assert", role: "status", name: "Check your inbox", value: "Check your inbox" },
      { action: "done", verdict: "pass", reason: "Saw the status" },
    ]);
    const r = await runScenario(scenario("R1", ["AC2"]), { baseUrl, model, artifactsDir: dir });
    expect(r.verdict).toBe("pass");
    expect(r.steps[3]).toMatchObject({ ok: true });
    // codegen uses the selector that actually matched, and stays exact where it can
    expect(r.steps[3]!.code).toBe('await expect(page.getByRole("status").filter({ hasText: "Check your inbox" }).first()).toBeVisible();');
    expect(r.steps[0]!.code).toBe('await page.getByRole("link", { name: "Forgot password?", exact: true }).click();');
  }, 30_000);

  it("stops a scenario that keeps repeating a failing action after the nudge", async () => {
    const model = scripted([{ action: "click", role: "button", name: "Nope" }]);
    const r = await runScenario(scenario("R2", ["AC1"]), { baseUrl, model, artifactsDir: dir, actionTimeoutMs: 200 });
    expect(r.steps).toHaveLength(3);
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toMatch(/stuck repeating "click button "Nope""/);
  }, 30_000);
});
