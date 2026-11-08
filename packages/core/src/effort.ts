/**
 * How hard the model "thinks" per stage. Reasoning tokens are the biggest
 * cost and latency driver (first real run: gpt-5 at default effort took
 * ~35 s per browser step and 2 min to plan). Clicking through a form does
 * not need deep reasoning; judging code against requirements does.
 */
export type Effort = "low" | "medium" | "high";
export type Stage = "review" | "plan" | "agent" | "infer";

export const DEFAULT_EFFORT: Record<Stage, Effort> = {
  review: "medium",
  plan: "low",
  agent: "low",
  infer: "low",
};

export type EffortConfig = Partial<Record<Stage, Effort>>;

/** Provider options for one call; each provider reads only its own key. */
export function providerOptionsFor(stage: Stage, cfg: EffortConfig = {}) {
  const effort = cfg[stage] ?? DEFAULT_EFFORT[stage];
  return {
    openai: { reasoningEffort: effort },
    anthropic: { effort },
  };
}
