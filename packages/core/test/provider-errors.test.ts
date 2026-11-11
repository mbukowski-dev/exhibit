import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APICallError, generateObject } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { z } from "zod";
// @ts-expect-error — plain JS demo app
import { createApp } from "../../../examples/demo-app/server.mjs";
import { runScenarios } from "../src/browser/agent.js";
import type { Scenario } from "../src/plan.js";
import { ModelProviderError, providerFailure, withProviderErrors } from "../src/provider-errors.js";

/** An error shaped like the ones the provider SDKs throw. */
const apiError = (statusCode: number, message: string, body = "") =>
  new APICallError({
    message,
    url: "https://api.example.test/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseBody: body,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });

/** A model whose every call fails with `error`; counts the attempts. */
function failing(error: Error) {
  return new MockLanguageModelV2({
    doGenerate: async () => {
      throw error;
    },
  });
}

describe("providerFailure: which model errors no retry can fix (E12-18)", () => {
  it("recognises an account without credits, however the provider words it", () => {
    // Seen in the self-test on 2026-11-11 (OpenAI): reported as "unverified" on every scenario.
    expect(providerFailure(apiError(429, "You have no credits remaining. Add credits to continue using the API"), "openai")?.kind).toBe("no_credits");
    expect(providerFailure(apiError(429, "You exceeded your current quota", '{"error":{"code":"insufficient_quota"}}'), "openai")?.kind).toBe("no_credits");
    expect(providerFailure(apiError(400, "Your credit balance is too low to access the Anthropic API."), "anthropic")?.kind).toBe("no_credits");
    expect(providerFailure(apiError(402, "Payment required"), "openai")?.kind).toBe("no_credits");
  });

  it("recognises a rejected key and an unknown model", () => {
    expect(providerFailure(apiError(401, "Incorrect API key provided"), "openai")?.kind).toBe("bad_key");
    expect(providerFailure(apiError(403, "Forbidden"), "anthropic")?.kind).toBe("bad_key");
    expect(providerFailure(apiError(404, "The model `gpt-9` does not exist"), "openai")?.kind).toBe("unknown_model");
  });

  it("leaves errors a retry can fix alone", () => {
    expect(providerFailure(apiError(429, "Rate limit reached for requests"), "openai")).toBeUndefined();
    expect(providerFailure(apiError(500, "Internal error"), "openai")).toBeUndefined();
    expect(providerFailure(apiError(400, "Invalid schema"), "openai")).toBeUndefined();
    expect(providerFailure(new Error("socket hang up"), "openai")).toBeUndefined();
  });

  it("says what to do, and which secret to look at", () => {
    const noCredits = providerFailure(apiError(429, "You have no credits remaining."), "openai")!;
    expect(noCredits.message).toMatch(/^No credits left on the OpenAI account/);
    expect(noCredits.message).toContain("Nothing was verified");
    expect(providerFailure(apiError(401, "bad key"), "anthropic")!.message).toContain("ANTHROPIC_API_KEY");
    expect(providerFailure(apiError(404, "no such model"), "openai")!.message).toContain("model.name");
  });
});

describe("a provider failure stops the run instead of looking like a verdict (E12-18)", () => {
  const Answer = z.object({ ok: z.boolean() });

  it("fails on the first attempt: retrying an empty account only wastes time", async () => {
    const raw = failing(apiError(429, "You have no credits remaining."));
    const model = withProviderErrors(raw, "openai");
    await expect(generateObject({ model, schema: Answer, prompt: "x" })).rejects.toBeInstanceOf(ModelProviderError);
    expect(raw.doGenerateCalls).toHaveLength(1);
  });

  it("still lets the SDK retry a real rate limit", async () => {
    const raw = failing(apiError(429, "Rate limit reached for requests"));
    const model = withProviderErrors(raw, "openai");
    await expect(generateObject({ model, schema: Answer, prompt: "x", maxRetries: 1 })).rejects.not.toBeInstanceOf(ModelProviderError);
    expect(raw.doGenerateCalls).toHaveLength(2);
  });

  describe("in the browser stage", () => {
    let server: Server;
    let baseUrl: string;
    let dir: string;
    beforeAll(async () => {
      server = createApp();
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      dir = await mkdtemp(join(tmpdir(), "exhibit-provider-"));
    });
    afterAll(async () => {
      server.close();
      await rm(dir, { recursive: true, force: true });
    });

    const scenario = (id: string): Scenario => ({
      id, title: id, acIds: ["AC1"], priority: "p1", role: "anonymous", startPath: "/login", steps: ["…"], expected: ["…"],
    });

    it("ends the whole run with one clear error, not a blocked scenario per criterion", async () => {
      const raw = failing(apiError(429, "You have no credits remaining."));
      const model = withProviderErrors(raw, "openai");
      await expect(runScenarios([scenario("S1"), scenario("S2")], { baseUrl, model, artifactsDir: dir })).rejects.toThrow(/No credits left on the OpenAI account/);
      expect(raw.doGenerateCalls).toHaveLength(1); // S2 never starts
    }, 30_000);
  });
});
