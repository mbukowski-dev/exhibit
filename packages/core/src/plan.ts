import type { LanguageModel } from "ai";
import { generateObjectWithRetry } from "./llm.js";
import { z } from "zod";
import type { VerificationContext } from "./context.js";
import { renderContext, UNTRUSTED_DATA_RULE } from "./prompt.js";
import type { Review } from "./review.js";
import { providerOptionsFor, type EffortConfig } from "./effort.js";
import type { UsageMeter } from "./usage.js";

export const ScenarioSchema = z.object({
  title: z.string(),
  acIds: z.array(z.string()).describe("Acceptance criteria this scenario verifies; [] for a pure regression check"),
  priority: z.enum(["p1", "p2", "p3"]).describe("p1: core of the ticket or high risk; p3: nice to have"),
  role: z.string().default("anonymous").describe("Which user role runs it, e.g. anonymous, user, admin"),
  startPath: z.string().describe("Relative URL path to start at, e.g. /login"),
  steps: z.array(z.string()).describe("Concrete user actions in the browser, one per item"),
  expected: z.array(z.string()).describe("Observable outcomes to check in the UI (may be empty only for notTestableInBrowser scenarios)"),
  notTestableInBrowser: z
    .string()
    .optional()
    .describe("Only when NOTHING in this scenario can be seen in the UI (e.g. email delivery, 30-minute expiry); say why. Leave empty if any expected result is visible on the page."),
});

const PlanSchema = z.object({ scenarios: z.array(ScenarioSchema).max(20) });

export type Scenario = z.infer<typeof ScenarioSchema> & { id: string };

export interface VerificationPlan {
  scenarios: Scenario[];
  /** Scenarios dropped by the limit, so the report can say what was not run. */
  skipped: Scenario[];
}

const SYSTEM = `You are Exhibit, a QA engineer planning how to verify a pull request in a running web app.
Write browser scenarios a tester (or a browser agent) can execute on the preview environment.
Rules:
- Every acceptance criterion gets at least one scenario, including negative/edge cases the AC implies.
- Add regression scenarios only for high or medium risk areas from the review.
- Steps are user actions (click, type, navigate), never code. Expected results are visible in the UI.
- Split an AC that has a part visible in the UI and a part that is not (e.g. "shows 'Check your inbox'
  AND sends an email"): one normal scenario that checks the visible part, plus one scenario with
  notTestableInBrowser for the invisible part. Never mark a scenario notTestableInBrowser if any of
  its expected results can be seen on the page.
- If an AC cannot be checked in a browser at all, still add a scenario and fill notTestableInBrowser.
- Do not invent features that are not in the ticket or the diff.
Write in the language of the ticket.
${UNTRUSTED_DATA_RULE}`;

/** E3-1 (scenarios mapped to AC) and E3-2 (risk-based priority + limit). */
export async function planVerification(
  ctx: VerificationContext,
  review: Review,
  model: LanguageModel,
  opts: { maxScenarios?: number; meter?: UsageMeter; effort?: EffortConfig } = {},
): Promise<VerificationPlan> {
  opts.meter?.assertBudget("plan");
  const reviewText = [
    "<review>",
    ...review.coverage.map((c) => `${c.acId}: ${c.status} — ${c.explanation}`),
    ...review.risks.map((r) => `risk ${r.severity}: ${r.area} — ${r.reason}`),
    "</review>",
  ].join("\n");

  const { object, usage } = await generateObjectWithRetry({
    model,
    schema: PlanSchema,
    system: SYSTEM,
    // The diff is already distilled into the review; skipping it keeps the plan step cheap.
    prompt: renderContext(ctx, { includeDiff: false }) + "\n\n" + reviewText,
    providerOptions: providerOptionsFor("plan", opts.effort),
  });
  opts.meter?.add("plan", usage);
  return prioritize(object.scenarios, ctx, opts.maxScenarios ?? 8);
}

/**
 * Deterministic ordering: p1 first; within a priority, scenarios covering
 * an AC nobody else covers yet come first. Then cap to `max`, but never
 * drop the only scenario for an AC while lower-priority ones remain.
 */
export function prioritize(
  raw: z.infer<typeof ScenarioSchema>[],
  ctx: VerificationContext,
  max: number,
): VerificationPlan {
  const known = new Set(ctx.criteria.map((c) => c.id));
  const all: Scenario[] = raw.map((s, i) => ({
    ...s,
    notTestableInBrowser:
      s.notTestableInBrowser?.trim() || (s.expected.length === 0 || s.steps.length === 0 ? "The plan gave no steps or expected results to check in the browser." : undefined),
    acIds: s.acIds.map((a) => a.toUpperCase().trim()).filter((a) => known.has(a)),
    id: `S${i + 1}`,
  }));
  const rank = { p1: 0, p2: 1, p3: 2 };
  all.sort((a, b) => rank[a.priority] - rank[b.priority]);

  const chosen: Scenario[] = [];
  const covered = new Set<string>();
  // Pass 1: one scenario per AC, in priority order.
  for (const s of all) {
    if (chosen.length >= max) break;
    if (s.acIds.some((a) => !covered.has(a))) {
      chosen.push(s);
      s.acIds.forEach((a) => covered.add(a));
    }
  }
  // Pass 2: fill remaining slots by priority.
  for (const s of all) {
    if (chosen.length >= max) break;
    if (!chosen.includes(s)) chosen.push(s);
  }
  chosen.sort((a, b) => rank[a.priority] - rank[b.priority]);
  const scenarios = chosen.map((s, i) => ({ ...s, id: `S${i + 1}` }));
  const skipped = all.filter((s) => !chosen.includes(s));
  return { scenarios, skipped };
}
