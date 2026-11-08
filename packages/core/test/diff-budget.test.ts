import { describe, expect, it } from "vitest";
import { budgetDiff } from "../src/diff-budget.js";

const file = (path: string, body: string, hunks = 1) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
  Array.from({ length: hunks }, (_, i) => `@@ -${i * 10 + 1},3 +${i * 10 + 1},4 @@\n${body}\n`).join("");

describe("budgetDiff (E11-3)", () => {
  it("returns small diffs untouched", () => {
    const d = file("src/a.ts", "+x");
    expect(budgetDiff(d, { maxChars: 10_000 })).toEqual({ diff: d, truncated: false, shortened: [], omitted: [] });
  });

  it("keeps files related to the acceptance criteria and lists what it dropped", () => {
    const filler = "+" + "x".repeat(3000);
    const d = [
      file("docs/changelog.md", filler),
      file("src/billing/invoice.ts", filler),
      file("test/reset.test.ts", "+expect(reset)"),
      file("src/auth/password-reset.ts", "+sendResetEmail(user)"),
    ].join("");
    const r = budgetDiff(d, { maxChars: 6_000, relevanceText: "Password reset: send reset email" });
    expect(r.diff).toContain("src/auth/password-reset.ts");
    expect(r.diff).toContain("test/reset.test.ts");
    expect(r.omitted).toContain("docs/changelog.md");
    expect(r.diff).toMatch(/lower-priority files omitted to fit the budget: .*docs\/changelog\.md/);
    // original order is kept for included files
    expect(r.diff.indexOf("test/reset.test.ts")).toBeLessThan(r.diff.indexOf("src/auth/password-reset.ts"));
  });

  it("shortens one huge file at a hunk boundary instead of letting it eat the budget", () => {
    const big = file("src/huge.ts", "+" + "y".repeat(900), 40);
    const small = file("src/small.ts", "+z");
    const r = budgetDiff(big + small, { maxChars: 15_000, perFileChars: 5_000 });
    expect(r.shortened).toEqual(["src/huge.ts"]);
    expect(r.diff).toContain("src/small.ts");
    expect(r.diff).toMatch(/more lines of this file omitted/);
    expect(r.diff.length).toBeLessThanOrEqual(15_000);
  });
});
