import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";
// @ts-expect-error — plain JS demo app
import { createApp } from "../../../examples/demo-app/server.mjs";
import { runScenario } from "../src/browser/agent.js";
import { parseConfig } from "../src/config.js";
import { blockedHint } from "../src/hints.js";
import type { Scenario } from "../src/plan.js";
import { ModelTimeoutError, withCallTimeout } from "../src/provider-errors.js";

/** A model that never answers, like a connection that hangs. It stops only when the call is aborted. */
function hanging() {
  return new MockLanguageModelV2({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
      }),
  });
}

const answering = (obj: unknown, delayMs = 0) =>
  new MockLanguageModelV2({
    doGenerate: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return { content: [{ type: "text", text: JSON.stringify(obj) }], finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, warnings: [] };
    },
  });

const Answer = z.object({ ok: z.boolean() });

describe("a model call that never answers (E12-8)", () => {
  it("is given up after the time limit instead of hanging until the CI job is killed", async () => {
    const raw = hanging();
    const started = Date.now();
    await expect(generateObject({ model: withCallTimeout(raw, 150), schema: Answer, prompt: "x" })).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(raw.doGenerateCalls).toHaveLength(1); // not retried: three hangs in a row would triple the wait
  });

  it("says how long it waited", async () => {
    await expect(generateObject({ model: withCallTimeout(hanging(), 1_500), schema: Answer, prompt: "x" })).rejects.toThrow("The model did not answer within 2 s.");
  });

  it("does not touch calls that answer in time", async () => {
    const { object } = await generateObject({ model: withCallTimeout(answering({ ok: true }, 20), 1_000), schema: Answer, prompt: "x" });
    expect(object).toEqual({ ok: true });
  });

  it("still honours the caller's own abort signal", async () => {
    const mine = AbortSignal.timeout(100);
    const err = await generateObject({ model: withCallTimeout(hanging(), 60_000), schema: Answer, prompt: "x", abortSignal: mine }).catch((e) => e);
    expect(err).not.toBeInstanceOf(ModelTimeoutError);
  });

  it("has defaults generous enough for slow reasoning models, and can be changed", () => {
    expect(parseConfig({}).model.call_timeout_s).toBe(180);
    expect(parseConfig({}).scenario_timeout_s).toBe(600);
    expect(parseConfig({ model: { call_timeout_s: 60 }, scenario_timeout_s: 120 })).toMatchObject({ model: { call_timeout_s: 60 }, scenario_timeout_s: 120 });
  });
});

describe("a scenario that takes too long (E12-8)", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  beforeAll(async () => {
    server = createApp();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "exhibit-timeouts-"));
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const scenario: Scenario = { id: "S1", title: "S1", acIds: ["AC1"], priority: "p1", role: "anonymous", startPath: "/forgot", steps: ["…"], expected: ["…"] };

  it("stops at the time limit, as blocked, and says why", async () => {
    const model = answering({ thought: "waiting", action: "wait" }, 120); // every step takes a while and never finishes
    const r = await runScenario(scenario, { baseUrl, model, artifactsDir: dir, maxSteps: 50, maxDurationMs: 600 });
    expect(r.verdict).toBe("blocked");
    expect(r.blocker).toBe("time_limit");
    expect(r.reason).toMatch(/^Time limit \(1 s\) reached/);
    expect(r.steps.length).toBeLessThan(50);
    expect(blockedHint(r, scenario, { auth: [] })?.kind).toBe("shortcut");
  }, 30_000);

  it("turns a hung model call into a blocked scenario, so the next scenario can still run", async () => {
    const r = await runScenario(scenario, { baseUrl, model: withCallTimeout(hanging(), 200), artifactsDir: dir });
    expect(r.verdict).toBe("blocked");
    expect(r.reason).toContain("The model did not answer within");
  }, 30_000);
});
