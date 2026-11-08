/**
 * USD per 1M tokens [input, output], list prices checked 2026-11.
 * Anthropic: first-party API prices. OpenAI: from third-party price trackers
 * (openai.com's pricing page could not be fetched) — override with
 * `model.price_per_mtok` in .exhibit.yml if they differ.
 * Haiku 5.5 is priced for prompts up to 100K tokens.
 */
export const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
};

/**
 * For models without a known price the cost cap is still enforced, using a
 * deliberately high rate so it errs on the safe side.
 */
export const UNKNOWN_MODEL_PRICE: [number, number] = [10, 50];

export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
}

/** Accumulates tokens across LLM steps of one run and enforces the cost cap (E7-2, E4-4). */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  readonly steps: { step: string; inputTokens: number; outputTokens: number }[] = [];
  /** False when the cost is an upper-bound estimate (price unknown). */
  readonly priceKnown: boolean;
  private readonly price: [number, number];

  constructor(
    readonly modelName: string,
    readonly maxCostUsd = Infinity,
    price: [number, number] | undefined = PRICES[modelName],
  ) {
    this.priceKnown = price !== undefined;
    this.price = price ?? UNKNOWN_MODEL_PRICE;
  }

  add(step: string, usage: UsageLike | undefined) {
    const i = usage?.inputTokens ?? 0;
    const o = usage?.outputTokens ?? 0;
    this.inputTokens += i;
    this.outputTokens += o;
    this.steps.push({ step, inputTokens: i, outputTokens: o });
  }

  /** Upper-bound estimate when `priceKnown` is false. */
  get costUsd(): number {
    return (this.inputTokens * this.price[0] + this.outputTokens * this.price[1]) / 1_000_000;
  }

  /** Throws before starting a step once the budget is spent. */
  assertBudget(nextStep: string) {
    const c = this.costUsd;
    if (c >= this.maxCostUsd) {
      throw new BudgetExceededError(
        `Cost limit $${this.maxCostUsd.toFixed(2)} reached (${this.priceKnown ? "" : "≤"}$${c.toFixed(2)}) before "${nextStep}". Raise model.max_cost_per_run_usd in .exhibit.yml.`,
      );
    }
  }

  summary(): string {
    const c = this.costUsd;
    const tokens = `${this.inputTokens.toLocaleString("en")} in / ${this.outputTokens.toLocaleString("en")} out`;
    const note = this.priceKnown ? "" : ", price unknown — upper bound";
    return `${this.priceKnown ? "" : "≤"}$${c.toFixed(3)} · ${tokens} tokens (${this.modelName}${note})`;
  }
}

export class BudgetExceededError extends Error {}
