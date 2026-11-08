import { describe, expect, it } from "vitest";
import { budgetNudge, checkPassEvidence, isStuck, loopNudge } from "../src/browser/nudges.js";
import type { StepRecord } from "../src/browser/agent.js";

let n = 0;
const st = (action: string, ok = true, extra: object = {}): StepRecord => ({
  n: ++n, ok, url: "/", action: { thought: "", action: action as any, ...extra }, ...(ok ? {} : { error: "timeout" }),
});

describe("checkPassEvidence (E11-1)", () => {
  it("rejects a pass with no assert", () => {
    expect(checkPassEvidence([st("click")], ["X shown"])?.message).toMatch(/not verified anything[\s\S]*X shown/);
  });
  it("rejects a pass when the last interaction came after the last assert", () => {
    expect(checkPassEvidence([st("assert"), st("click", true, { role: "button", name: "Save" })], [])?.message).toMatch(/after your last action \(#\d+ click button "Save"\)/);
  });
  it("ignores failed asserts and failed interactions", () => {
    expect(checkPassEvidence([st("assert", false)], [])).toBeDefined();
    expect(checkPassEvidence([st("assert"), st("click", false)], [])).toBeUndefined();
  });
  it("accepts click → assert", () => {
    expect(checkPassEvidence([st("click"), st("fill"), st("assert")], [])).toBeUndefined();
  });
});

describe("loopNudge (E11-2)", () => {
  it("fires once for the same action failing twice", () => {
    const seen = new Set<string>();
    const steps = [st("click", false, { name: "A" }), st("click", false, { name: "A" })];
    expect(loopNudge(steps, seen)?.kind).toBe("loop");
    expect(loopNudge([...steps, st("click", false, { name: "A" })], seen)).toBeUndefined();
  });
  it("fires for three identical actions even when they succeed", () => {
    expect(loopNudge([st("wait"), st("wait"), st("wait")], new Set())?.message).toMatch(/three times/);
  });
  it("stays quiet for different actions", () => {
    expect(loopNudge([st("click", false, { name: "A" }), st("click", false, { name: "B" })], new Set())).toBeUndefined();
  });
});

describe("budgetNudge (E11-2)", () => {
  it("fires once at 75% of the budget", () => {
    const fired = Array.from({ length: 20 }, (_, i) => budgetNudge(i + 1, 20)).filter(Boolean);
    expect(fired).toHaveLength(1);
    expect(budgetNudge(15, 20)?.message).toMatch(/Only 6 steps left/);
  });
  it("does not fire for tiny budgets", () => {
    expect(budgetNudge(2, 3)).toBeUndefined();
  });
});

describe("isStuck (E11-2 hard brake)", () => {
  it("fires only after the loop was already nudged", () => {
    const seen = new Set<string>();
    const f = () => st("click", false, { name: "A" });
    const steps = [f(), f()];
    expect(isStuck(steps, seen)).toBeUndefined();
    loopNudge(steps, seen);
    expect(isStuck([...steps, f()], seen)?.action.name).toBe("A");
  });
  it("ignores successful repeats", () => {
    const seen = new Set(["wait|||"]);
    expect(isStuck([st("wait"), st("wait")], seen)).toBeUndefined();
  });
});
