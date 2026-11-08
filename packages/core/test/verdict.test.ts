import { describe, expect, it } from "vitest";
import { judge } from "../src/verdict.js";
import { statusFor } from "../src/github.js";
import type { ScenarioResult } from "../src/browser/agent.js";

const ac = (id: string) => ({ id, text: id, source: "section" as const });
const res = (scenarioId: string, acIds: string[], verdict: ScenarioResult["verdict"], reason = ""): ScenarioResult => ({
  scenarioId, title: scenarioId, acIds, verdict, reason, steps: [], consoleErrors: [], failedRequests: [], artifacts: {}, durationMs: 0, nudges: [],
});
const noReview = { coverage: [], risks: [] };

describe("judge (E6-1)", () => {
  it("partial: the visible part passed, the rest is not testable in a browser (self-test run 3, AC2)", () => {
    const v = judge([ac("AC2")], noReview, [
      res("S2", ["AC2"], "pass", "Saw 'Check your inbox'"),
      res("S3", ["AC2"], "blocked", "Not testable in the browser: email delivery"),
    ]);
    expect(v.criteria[0]!.verdict).toBe("partial");
    expect(v.criteria[0]!.summary).toBe("S2: Saw 'Check your inbox' Not verified: S3 — Not testable in the browser: email delivery");
    expect(v.overall).toBe("needs_review");
  });

  it("pass only when every scenario of the AC passed", () => {
    expect(judge([ac("AC1")], noReview, [res("S1", ["AC1"], "pass"), res("S2", ["AC1"], "pass")]).criteria[0]!.verdict).toBe("pass");
  });

  it("a failing scenario wins over passing ones", () => {
    expect(judge([ac("AC3")], noReview, [res("S1", ["AC3"], "pass"), res("S2", ["AC3"], "fail", "bug")]).criteria[0]!.verdict).toBe("fail");
  });

  it("never fails without browser evidence, even if the diff lacks it", () => {
    const review = { coverage: [{ acId: "AC4", status: "missing" as const, evidence: [], explanation: "no TTL in diff" }], risks: [] };
    expect(judge([ac("AC4")], review, [res("S4", ["AC4"], "blocked", "not testable")]).criteria[0]!.verdict).toBe("unverified");
  });

  it("status text counts partial and unverified separately", () => {
    const v = judge([ac("AC1"), ac("AC2"), ac("AC3"), ac("AC4")], noReview, [
      res("S1", ["AC1"], "pass"),
      res("S2", ["AC2"], "pass"), res("S3", ["AC2"], "blocked"),
      res("S4", ["AC3"], "fail"),
      res("S5", ["AC4"], "blocked"),
    ]);
    expect(v.criteria.map((c) => c.verdict)).toEqual(["pass", "partial", "fail", "unverified"]);
    expect(statusFor(v, "comment").description).toBe("1 of 4 acceptance criteria not met, 1 partly verified, 1 unverified (advisory)");
  });
});
