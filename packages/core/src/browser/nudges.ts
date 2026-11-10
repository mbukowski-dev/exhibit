import type { StepRecord } from "./agent.js";

/**
 * E11-1 / E11-2: supervisor rules around the agent. Pure functions over the
 * step history so they are cheap to test and easy to tune from run logs.
 */
export type NudgeKind = "unverified_pass" | "loop" | "budget";

export interface Nudge {
  kind: NudgeKind;
  message: string;
}

const INTERACTIONS = new Set(["click", "fill", "select", "check", "press", "goto"]);

const describe = (s: StepRecord) => {
  const a = s.action;
  return `#${s.n} ${a.action}${a.role ? ` ${a.role}` : ""}${a.name ? ` "${a.name}"` : ""}${a.value ? ` = ${a.value}` : ""}`;
};

export const signature = (s: StepRecord) => {
  const a = s.action;
  return [a.action, a.role ?? "", a.name ?? "", a.value ?? ""].join("|");
};

/**
 * E11-1: a "pass" is only accepted when the page was verified with a
 * successful assert AFTER the last interaction — and (E12-4) when every
 * expected result has a successful assert that names it ("expects").
 * Returns the reason to reject, or undefined when the pass is backed by evidence.
 */
export function checkPassEvidence(steps: StepRecord[], expected: string[]): Nudge | undefined {
  let lastAssert = -1;
  let lastInteraction = -1;
  /** Expected results (1-based) that have a successful assert of their own. */
  const covered = new Set<number>();
  /** True once an "assert" succeeded on the page as it is now, i.e. since the last interaction. */
  let anchored = false;
  steps.forEach((s, i) => {
    if (!s.ok) return;
    const a = s.action;
    if (a.action === "assert") {
      lastAssert = i;
      anchored = true;
      if (a.expects) covered.add(a.expects);
    } else if (a.action === "assert_absent") {
      // Right after a click nothing has rendered yet, so "it is not there" would be trivially true.
      if (anchored && a.expects) covered.add(a.expects);
    } else if (INTERACTIONS.has(a.action)) {
      lastInteraction = i;
      anchored = false;
    }
  });
  const exp = expected.map((e) => `- ${e}`).join("\n");
  if (lastAssert < 0) {
    return {
      kind: "unverified_pass",
      message: `You reported "pass" but have not verified anything. Use "assert" on visible text or elements for each expected result, then finish:\n${exp}`,
    };
  }
  if (lastInteraction > lastAssert) {
    return {
      kind: "unverified_pass",
      message: `You reported "pass", but the page was not verified after your last action (${describe(steps[lastInteraction]!)}). Use "assert" to check the expected results on the current page, then finish:\n${exp}`,
    };
  }
  // E12-4: with several expected results, one assert of anything is not enough —
  // each result needs its own. A single expected result stays simple.
  if (expected.length < 2) return undefined;
  const missing = expected.map((e, i) => ({ n: i + 1, e })).filter((x) => !covered.has(x.n));
  if (!missing.length) return undefined;
  return {
    kind: "unverified_pass",
    message:
      `You reported "pass", but ${missing.length === 1 ? "this expected result has" : "these expected results have"} no successful assert of ${missing.length === 1 ? "its" : "their"} own:\n` +
      missing.map((x) => `${x.n}. ${x.e}`).join("\n") +
      `\nCheck each one with "assert" (or "assert_absent" when something must NOT be shown) and set "expects" to its number. ` +
      `"assert_absent" only counts after a successful "assert" on the same page, so we know the page has finished loading. ` +
      `If a result is not true, finish with fail; if it cannot be checked, finish with blocked.`,
  };
}

/**
 * E11-2: the same failing action twice in a row, or the same action three
 * times in a row, means the agent is stuck. Each loop is nudged once.
 */
export function loopNudge(steps: StepRecord[], alreadyNudged: Set<string>): Nudge | undefined {
  const [a, b, c] = steps.slice(-3).reverse();
  if (!a || !b) return undefined;
  const sig = signature(a);
  if (alreadyNudged.has(sig)) return undefined;
  if (!a.ok && !b.ok && sig === signature(b)) {
    alreadyNudged.add(sig);
    return {
      kind: "loop",
      message: `"${describe(a).replace(/^#\d+ /, "")}" failed twice (${a.error}). Do not repeat it. Pick a different element from the snapshot or another way to reach the goal; if it is impossible, finish with done: blocked and explain why.`,
    };
  }
  if (c && sig === signature(b) && sig === signature(c)) {
    alreadyNudged.add(sig);
    return {
      kind: "loop",
      message: `You repeated "${describe(a).replace(/^#\d+ /, "")}" three times. Move on: take the next scenario step, verify with "assert", or finish with done.`,
    };
  }
  return undefined;
}

/**
 * E11-2 hard brake: the agent was already told to stop repeating a failing
 * action and did it again. Further attempts only burn time and money
 * (self-test run 2: 15 identical failed asserts after the nudge).
 */
export function isStuck(steps: StepRecord[], alreadyNudged: Set<string>): StepRecord | undefined {
  const last = steps[steps.length - 1];
  const prev = steps[steps.length - 2];
  if (!last || !prev || last.ok || prev.ok) return undefined;
  const sig = signature(last);
  return alreadyNudged.has(sig) && sig === signature(prev) ? last : undefined;
}

/** E11-2: one reminder when 75% of the step budget is used. */
export function budgetNudge(step: number, maxSteps: number): Nudge | undefined {
  const at = Math.max(2, Math.ceil(maxSteps * 0.75));
  if (step !== at || maxSteps < 4) return undefined;
  const left = maxSteps - step + 1;
  return {
    kind: "budget",
    message: `Only ${left} steps left. Verify the expected results with "assert" now and finish with done (pass, fail or blocked).`,
  };
}

/** How many unverified "pass" claims we push back before giving up. */
export const MAX_PASS_REJECTIONS = 2;
