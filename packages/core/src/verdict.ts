import type { ScenarioResult } from "./browser/agent.js";
import type { AcceptanceCriterion } from "./acceptance.js";
import type { Review } from "./review.js";

export type AcVerdict = "pass" | "partial" | "fail" | "unverified";

export interface AcResult {
  acId: string;
  text: string;
  verdict: AcVerdict;
  /** Short, human-readable justification combining code and browser evidence. */
  summary: string;
  code: Review["coverage"][number] | undefined;
  scenarios: Pick<ScenarioResult, "scenarioId" | "title" | "verdict" | "reason">[];
}

export interface RunVerdict {
  overall: "pass" | "fail" | "needs_review";
  criteria: AcResult[];
}

/**
 * E6-1: deterministic judge. Browser evidence outranks code reading:
 * - any failing scenario → fail
 * - every scenario passed → pass
 * - some passed, the rest could not run (blocked / not testable in a browser)
 *   → partial: the checked part works, the rest needs another kind of check
 * - nothing ran (all blocked / untestable) → unverified (a human must look);
 *   a ❌ is only ever given on browser evidence, because "missing in the diff"
 *   does not mean "missing in the app" (lesson from the first real run).
 */
export function judge(criteria: AcceptanceCriterion[], review: Review, results: ScenarioResult[]): RunVerdict {
  const out: AcResult[] = criteria.map((ac) => {
    const code = review.coverage.find((c) => c.acId === ac.id);
    const scenarios = results
      .filter((r) => r.acIds.includes(ac.id))
      .map(({ scenarioId, title, verdict, reason }) => ({ scenarioId, title, verdict, reason }));
    const failed = scenarios.filter((s) => s.verdict === "fail");
    const passed = scenarios.filter((s) => s.verdict === "pass");

    let verdict: AcVerdict;
    let summary: string;
    if (failed.length) {
      verdict = "fail";
      summary = failed.map((s) => `${s.scenarioId}: ${s.reason}`).join(" ");
    } else if (passed.length) {
      const notRun = scenarios.filter((s) => s.verdict !== "pass");
      verdict = notRun.length ? "partial" : "pass";
      summary = passed.map((s) => `${s.scenarioId}: ${s.reason}`).join(" ");
      if (notRun.length) summary += ` Not verified: ${notRun.map((s) => `${s.scenarioId} — ${s.reason}`).join(" ")}`;
      if (code?.status === "missing") summary += " (Note: code review found no implementation in the diff — it may predate this PR.)";
    } else if (code?.status === "missing") {
      // "missing" means "not in this diff" — the feature may already exist.
      // Without browser evidence that is a question for a human, not a ❌.
      verdict = "unverified";
      const why = scenarios.map((s) => s.reason).filter(Boolean).join(" ");
      summary = `Not in this change and could not be verified in the browser. Code review: ${code.explanation}${why ? ` Browser: ${why}` : ""}`;
    } else {
      verdict = "unverified";
      const why = scenarios.map((s) => s.reason).filter(Boolean).join(" ") || "No scenario covered this criterion.";
      summary = code ? `Code: ${code.status}. ${why}` : why;
    }
    return { acId: ac.id, text: ac.text, verdict, summary, code, scenarios };
  });

  const overall = out.some((a) => a.verdict === "fail")
    ? "fail"
    : out.length && out.every((a) => a.verdict === "pass")
      ? "pass"
      : "needs_review";
  return { overall, criteria: out };
}
