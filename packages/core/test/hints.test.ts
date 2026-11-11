import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
// @ts-expect-error — plain JS demo app
import { createApp } from "../../../examples/demo-app/server.mjs";
import { runScenario, runScenarios, type ScenarioResult } from "../src/browser/agent.js";
import type { AgentAction } from "../src/browser/actions.js";
import { blockedHint } from "../src/hints.js";
import type { Scenario } from "../src/plan.js";
import { renderHints } from "../src/report-md.js";

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

const scenario = (extra: Partial<Scenario> = {}): Scenario => ({
  id: "S1", title: "S1", acIds: ["AC1"], priority: "p1", role: "anonymous", startPath: "/login", steps: ["…"], expected: ["…"], ...extra,
});

const blocked = (extra: Partial<ScenarioResult> = {}): ScenarioResult => ({
  scenarioId: "S1", title: "S1", acIds: ["AC1"], verdict: "blocked", reason: "…", steps: [], consoleErrors: [], failedRequests: [],
  artifacts: {}, durationMs: 0, nudges: [], blocker: "agent", ...extra,
});

const NO_AUTH = { auth: [] };
const WITH_AUTH = { auth: [{ role: "user", username_env: "EXHIBIT_USERNAME", password_env: "EXHIBIT_PASSWORD" }] };

let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-hints-"));
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("why a scenario was blocked is recorded, not only described (E13-2)", () => {
  it("notes that the agent gave up, and that it ended on a sign-in page", async () => {
    const model = scripted([{ action: "done", verdict: "blocked", reason: "Strona wymaga logowania." }]); // any language
    const r = await runScenario(scenario({ role: "user" }), { baseUrl, model, artifactsDir: dir });
    expect(r.verdict).toBe("blocked");
    expect(r.blocker).toBe("agent");
    expect(r.endedOnLoginPage).toBe(true);
  }, 30_000);

  it("notes a step limit", async () => {
    const model = scripted([{ action: "wait" }]);
    const r = await runScenario(scenario({ startPath: "/forgot" }), { baseUrl, model, artifactsDir: dir, maxSteps: 3 });
    expect(r.blocker).toBe("step_limit");
    expect(r.endedOnLoginPage).toBe(false);
  }, 30_000);

  it("notes a failed login script", async () => {
    const model = scripted([{ action: "done", verdict: "pass" }]);
    const r = await runScenario(scenario(), { baseUrl, model, artifactsDir: dir, login: async () => { throw new Error("no such user"); } });
    expect(r.blocker).toBe("login_failed");
  }, 30_000);

  it("notes what a browser cannot test, and leaves passed scenarios alone", async () => {
    const model = scripted([{ action: "assert", role: "link", name: "Forgot password?" }, { action: "done", verdict: "pass", reason: "Link shown" }]);
    const [untestable, passed] = await runScenarios(
      [scenario({ id: "S1", notTestableInBrowser: "needs an e-mail" }), scenario({ id: "S2" })],
      { baseUrl, model, artifactsDir: dir },
    );
    expect(untestable!.blocker).toBe("not_testable");
    expect(passed!.verdict).toBe("pass");
    expect(passed!.blocker).toBeUndefined();
  }, 30_000);
});

describe("blockedHint: what would unblock a scenario (E13-2)", () => {
  it("asks for a test account when a signed-in role has none configured, with the config to paste", () => {
    const h = blockedHint(blocked(), scenario({ role: "admin" }), NO_AUTH)!;
    expect(h.kind).toBe("add_auth");
    expect(h.text).toContain('signed in as "admin"');
    expect(h.snippet).toBe("auth:\n  - role: admin\n    username_env: EXHIBIT_USERNAME\n    password_env: EXHIBIT_PASSWORD");
  });

  it("asks for a test account when an anonymous scenario ran into a sign-in page", () => {
    const h = blockedHint(blocked({ endedOnLoginPage: true }), scenario(), NO_AUTH)!;
    expect(h.kind).toBe("add_auth");
    expect(h.snippet).toContain("role: user");
  });

  it("asks for a test account when the agent reached for credentials that do not exist", () => {
    const step = { n: 1, ok: false, url: "/login", error: "No secret named {{username}} (available: none).", action: { thought: "", action: "fill" as const } };
    expect(blockedHint(blocked({ steps: [step] }), scenario(), NO_AUTH)!.kind).toBe("add_auth");
  });

  it("never pastes a role name it cannot trust into the config snippet", () => {
    const h = blockedHint(blocked(), scenario({ role: "admin`\n  evil: true" }), NO_AUTH)!;
    expect(h.snippet).toContain("role: user");
    expect(h.text).not.toContain("evil");
  });

  it("points at the account or the login script when signing in failed", () => {
    expect(blockedHint(blocked({ blocker: "login_failed" }), scenario({ role: "user" }), WITH_AUTH)!.kind).toBe("check_login");
    expect(blockedHint(blocked({ endedOnLoginPage: true }), scenario({ role: "user" }), WITH_AUTH)!.kind).toBe("check_login");
  });

  it("has a specific suggestion for each way a run stops", () => {
    const kind = (b: ScenarioResult["blocker"], extra: Partial<ScenarioResult> = {}) => blockedHint(blocked({ blocker: b, ...extra }), scenario(), NO_AUTH)?.kind;
    expect(kind("step_limit")).toBe("shortcut");
    expect(kind("stuck")).toBe("label");
    expect(kind("unverified_pass")).toBe("expected_wording");
    expect(kind("guessed_url")).toBe("needs_link");
    expect(kind("run_error", { reason: "Run error: page.goto: net::ERR_CONNECTION_REFUSED at http://x" })).toBe("unreachable");
    expect(kind("agent")).toBe("notes");
  });

  it("says nothing when there is nothing the team can do in the config", () => {
    expect(blockedHint(blocked({ blocker: "not_testable" }), scenario(), NO_AUTH)).toBeUndefined();
    expect(blockedHint(blocked({ blocker: "cost_limit" }), scenario(), NO_AUTH)).toBeUndefined(); // the reason already says what to raise
    expect(blockedHint(blocked({ blocker: "run_error", reason: "Run error: something odd" }), scenario(), NO_AUTH)).toBeUndefined();
    expect(blockedHint(blocked({ verdict: "pass", blocker: undefined }), scenario({ role: "user" }), NO_AUTH)).toBeUndefined();
    expect(blockedHint(blocked({ verdict: "fail", blocker: undefined }), scenario({ role: "user" }), NO_AUTH)).toBeUndefined();
  });
});

describe("the report says what would unblock them (E13-2)", () => {
  const addAuth = blockedHint(blocked(), scenario({ role: "user" }), NO_AUTH)!;
  const notes = blockedHint(blocked(), scenario(), NO_AUTH)!;

  it("groups scenarios that need the same thing and shows the config once", () => {
    const md = renderHints([
      blocked({ scenarioId: "S2", hint: addAuth }),
      blocked({ scenarioId: "S3", hint: notes }),
      blocked({ scenarioId: "S4", hint: addAuth }),
      blocked({ scenarioId: "S5", verdict: "pass" }),
    ]).join("\n");
    expect(md).toContain("**S2, S4:**");
    expect(md).toContain("**S3:**");
    expect(md.match(/```yaml/g)).toHaveLength(1);
    // The snippet sits inside the list item and keeps its own nesting, so it can be pasted as is.
    expect(md).toContain("  ```yaml\n  auth:\n    - role: user\n      username_env: EXHIBIT_USERNAME\n      password_env: EXHIBIT_PASSWORD\n  ```");
    expect(md).not.toContain("S5");
  });

  it("adds nothing when no scenario has a suggestion", () => {
    expect(renderHints([blocked(), blocked({ verdict: "pass" })])).toEqual([]);
  });
});
