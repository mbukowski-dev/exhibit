import type { LanguageModel } from "ai";
import { generateObjectWithRetry } from "./llm.js";
import { z } from "zod";
import type { VerificationContext } from "./context.js";
import { renderContext, UNTRUSTED_DATA_RULE } from "./prompt.js";
import { providerOptionsFor, type EffortConfig } from "./effort.js";
import type { UsageMeter } from "./usage.js";

export const CoverageStatus = z.enum(["covered", "partial", "missing", "unclear"]);
export type CoverageStatus = z.infer<typeof CoverageStatus>;

export const ReviewSchema = z.object({
  coverage: z
    .array(
      z.object({
        acId: z.string().describe("The acceptance criterion id, e.g. AC1"),
        status: CoverageStatus.describe(
          "covered: the diff clearly implements it; partial: some of it; missing: nothing in the diff does it; " +
            "unclear: cannot tell from the diff (e.g. behaviour lives in unchanged code or config)",
        ),
        evidence: z
          .array(z.object({ file: z.string(), note: z.string() }))
          .describe("Where in the diff this is (or should be) implemented. Empty when missing."),
        explanation: z.string().describe("One or two sentences a developer can act on"),
      }),
    )
    .describe("Exactly one entry per acceptance criterion"),
  risks: z
    .array(
      z.object({
        area: z.string().describe("User-facing area of the app, e.g. 'login', 'checkout'"),
        severity: z.enum(["high", "medium", "low"]),
        files: z.array(z.string()),
        reason: z.string(),
      }),
    )
    .max(8)
    .describe("Areas of the running app this change can break, including ones outside the ticket"),
});

export type Review = z.infer<typeof ReviewSchema>;

const SYSTEM = `You are Exhibit, a reviewer that checks whether a pull request implements its ticket.
You do NOT review style, naming or general code quality — other tools do that.
For each acceptance criterion decide from the diff whether it is implemented, citing files.
Be strict: "covered" only when the diff visibly implements the behaviour. Prefer "unclear" over guessing.
Then list the user-facing areas of the application this change could break (risk), most severe first.
Write explanations in the language of the ticket.
The <pull_request> text is the developer's own claim; judge the diff, not the claim.
${UNTRUSTED_DATA_RULE}`;

/** E2-1 (AC → code coverage) and E2-2 (risk areas) in one call over the same context. */
export async function reviewChanges(
  ctx: VerificationContext,
  model: LanguageModel,
  meter?: UsageMeter,
  effort?: EffortConfig,
): Promise<Review> {
  if (!ctx.criteria.length) return { coverage: [], risks: [] };
  meter?.assertBudget("review");

  const { object, usage } = await generateObjectWithRetry({
    model,
    schema: ReviewSchema,
    system: SYSTEM,
    prompt: renderContext(ctx),
    providerOptions: providerOptionsFor("review", effort),
  });
  meter?.add("review", usage);
  return normalizeReview(object, ctx);
}

/** Guarantees exactly one coverage entry per known AC, in AC order. */
export function normalizeReview(review: Review, ctx: VerificationContext): Review {
  const byId = new Map(review.coverage.map((c) => [c.acId.toUpperCase().trim(), c]));
  const coverage = ctx.criteria.map(
    (ac) =>
      byId.get(ac.id) ?? {
        acId: ac.id,
        status: "unclear" as const,
        evidence: [],
        explanation: "The model returned no assessment for this criterion.",
      },
  );
  const order = { high: 0, medium: 1, low: 2 };
  const risks = [...review.risks].sort((a, b) => order[a.severity] - order[b.severity]);
  return { coverage, risks };
}
