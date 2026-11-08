import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { reviewChanges } from "../src/review.js";
import { planVerification, prioritize } from "../src/plan.js";
import { UsageMeter, BudgetExceededError } from "../src/usage.js";
import { resolveModelConfig } from "../src/model.js";
import type { VerificationContext } from "../src/context.js";

const ctx: VerificationContext = {
  ticket: { key: "PROJ-123", url: "", summary: "Password reset", type: "", status: "", description: "", comments: [] },
  criteria: [
    { id: "AC1", text: "Forgot password link on login page", source: "section" },
    { id: "AC2", text: "Reset link expires after 30 minutes", source: "section" },
  ],
  changes: {
    source: "git", base: "abc", head: "HEAD", branch: "feature/proj-123",
    files: [{ path: "login.tsx", status: "modified", additions: 1, deletions: 0 }],
    diff: "+<a href=\"/forgot\">Forgot password?</a>", truncated: false,
  },
  warnings: [],
};

/** A fake model that returns `obj` as its JSON answer and reports token usage. */
function mockModel(obj: unknown, usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 }) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: "stop",
      usage,
      warnings: [],
    }),
  });
}

describe("reviewChanges (E2-1, E2-2)", () => {
  it("returns one entry per AC in AC order, filling gaps as unclear", async () => {
    const model = mockModel({
      coverage: [{ acId: "AC1", status: "covered", evidence: [{ file: "login.tsx", note: "link added" }], explanation: "Link added." }],
      risks: [
        { area: "signup", severity: "low", files: [], reason: "shared form" },
        { area: "login", severity: "high", files: ["login.tsx"], reason: "login page changed" },
      ],
    });
    const meter = new UsageMeter("claude-opus-5-5");
    const review = await reviewChanges(ctx, model, meter);

    expect(review.coverage.map((c) => [c.acId, c.status])).toEqual([["AC1", "covered"], ["AC2", "unclear"]]);
    expect(review.risks[0]!.severity).toBe("high"); // sorted most severe first
    expect(meter.inputTokens).toBe(1000);
  });

  it("puts the ticket, criteria and diff into the prompt", async () => {
    const model = mockModel({ coverage: [], risks: [] });
    await reviewChanges(ctx, model);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("PROJ-123");
    expect(prompt).toContain("AC2: Reset link expires after 30 minutes");
    expect(prompt).toContain("Forgot password?");
  });

  it("does not call the model when there are no criteria", async () => {
    const model = mockModel({ coverage: [], risks: [] });
    await reviewChanges({ ...ctx, criteria: [] }, model);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

const scenario = (title: string, acIds: string[], priority: "p1" | "p2" | "p3") => ({
  title, acIds, priority, role: "anonymous", startPath: "/", steps: ["open"], expected: ["ok"],
});

describe("prioritize (E3-2)", () => {
  it("orders by priority and keeps at least one scenario per AC under the limit", () => {
    const plan = prioritize(
      [
        scenario("AC1 happy", ["AC1"], "p1"),
        scenario("AC1 edge", ["ac1"], "p1"),
        scenario("regression", [], "p2"),
        scenario("AC2 expiry", ["AC2"], "p3"),
      ],
      ctx,
      2,
    );
    expect(plan.scenarios.map((s) => s.title)).toEqual(["AC1 happy", "AC2 expiry"]);
    expect(plan.scenarios.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(plan.skipped.map((s) => s.title)).toEqual(["AC1 edge", "regression"]);
  });

  it("drops AC ids that are not in the ticket", () => {
    const plan = prioritize([scenario("x", ["AC9", "AC1"], "p1")], ctx, 5);
    expect(plan.scenarios[0]!.acIds).toEqual(["AC1"]);
  });
});

describe("planVerification (E3-1)", () => {
  it("does not send the diff again and tracks usage", async () => {
    const model = mockModel({ scenarios: [scenario("Link visible", ["AC1"], "p1")] });
    const meter = new UsageMeter("claude-opus-5-5");
    const plan = await planVerification(ctx, { coverage: [], risks: [] }, model, { meter });
    expect(plan.scenarios).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain("</diff>");
    expect(meter.steps.map((s) => s.step)).toEqual(["plan"]);
  });
});

describe("UsageMeter (E7-2)", () => {
  it("computes cost from list prices", () => {
    const m = new UsageMeter("claude-opus-5-5");
    m.add("x", { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(m.costUsd).toBeCloseTo(4 + 2);
  });
  it("uses an explicit price override", () => {
    const m = new UsageMeter("some-model", Infinity, [1, 10]);
    m.add("x", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(m.costUsd).toBe(1);
    expect(m.priceKnown).toBe(true);
  });
  it("stops before a step once the budget is spent", () => {
    const m = new UsageMeter("claude-opus-5-5", 0.01);
    m.add("review", { inputTokens: 10_000, outputTokens: 0 }); // $0.04
    expect(() => m.assertBudget("plan")).toThrow(BudgetExceededError);
  });
  it("still enforces the cap for unknown prices, with a conservative upper bound", () => {
    const m = new UsageMeter("some-new-model", 0.5);
    expect(m.priceKnown).toBe(false);
    m.add("x", { inputTokens: 50_000, outputTokens: 0 }); // 50k × $10/M = $0.50
    expect(() => m.assertBudget("next")).toThrow(BudgetExceededError);
    expect(m.summary()).toMatch(/^≤\$0\.500/);
  });
  it("knows gpt-5", () => {
    const m = new UsageMeter("gpt-5");
    m.add("x", { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(m.costUsd).toBeCloseTo(1.25 + 1);
  });
});

describe("model selection", () => {
  const cfg = { provider: "anthropic" as const, max_cost_per_run_usd: 1.5 };
  it("switches provider when only the other key is set", () => {
    const r = resolveModelConfig(cfg, {}, { OPENAI_API_KEY: "x" });
    expect(r.model.provider).toBe("openai");
    expect(r.note).toMatch(/using openai/);
  });
  it("keeps the configured provider when its key exists or it is forced", () => {
    expect(resolveModelConfig(cfg, {}, { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }).model.provider).toBe("anthropic");
    expect(resolveModelConfig(cfg, { provider: "anthropic" }, { OPENAI_API_KEY: "x" }).model.provider).toBe("anthropic");
  });
  it("does not carry a model name across providers", () => {
    const r = resolveModelConfig({ ...cfg, name: "claude-sonnet-5-5" }, {}, { OPENAI_API_KEY: "x" });
    expect(r.model.name).toBeUndefined();
  });
});

describe("lessons from self-test run 4", () => {
  const split = {
    scenarios: [
      { title: "AC2 (UI): shows Check your inbox", acIds: ["AC2"], priority: "p1", role: "anonymous", startPath: "/login", steps: ["open", "submit"], expected: ["Check your inbox"] },
      { title: "AC2 (email): reset email sent", acIds: ["AC2"], priority: "p1", role: "anonymous", startPath: "/login", steps: ["submit"], expected: [], notTestableInBrowser: "needs a mailbox" },
    ],
  };

  it("accepts a split plan whose not-testable part has no expected results", async () => {
    const plan = await planVerification(ctx, { coverage: [], risks: [] }, mockModel(split));
    expect(plan.scenarios.map((s) => [s.title, Boolean(s.notTestableInBrowser)])).toEqual([
      ["AC2 (UI): shows Check your inbox", false],
      ["AC2 (email): reset email sent", true],
    ]);
  });

  it("marks a 'testable' scenario with nothing to check as not testable", async () => {
    const empty = { scenarios: [{ ...split.scenarios[0], expected: [] }] };
    const plan = await planVerification(ctx, { coverage: [], risks: [] }, mockModel(empty));
    expect(plan.scenarios[0]!.notTestableInBrowser).toMatch(/no steps or expected results/);
  });

  it("retries the plan once when the answer does not match the schema", async () => {
    let i = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: "text", text: i++ === 0 ? JSON.stringify({ scenarios: "oops" }) : JSON.stringify(split) }],
        finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, warnings: [],
      }),
    });
    const meter = new UsageMeter("claude-opus-5-5");
    const plan = await planVerification(ctx, { coverage: [], risks: [] }, model, { meter });
    expect(plan.scenarios).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("did not match the required schema");
    expect(meter.inputTokens).toBe(200); // both attempts are paid for and counted
  });
});
