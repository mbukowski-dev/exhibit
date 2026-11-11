import { APICallError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

/**
 * E12-18: a model provider that refuses to work is not a verification result.
 * An empty account, a rejected key or an unknown model used to surface as
 * "unverified" on every scenario (after three futile retries each), under a
 * green status. These errors now stop the run at once with one sentence that
 * says what to fix.
 */
export type ProviderName = "openai" | "anthropic";

export interface ProviderFailure {
  kind: "no_credits" | "bad_key" | "unknown_model";
  message: string;
}

/** Thrown instead of the provider's own error when no retry can help. */
export class ModelProviderError extends Error {
  constructor(
    readonly kind: ProviderFailure["kind"],
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

const LABEL: Record<ProviderName, string> = { openai: "OpenAI", anthropic: "Anthropic" };
const KEY_ENV: Record<ProviderName, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/** Providers word "the account is empty" differently and use different status codes for it. */
const NO_CREDITS = /insufficient_quota|no credits|credit balance|exceeded your current quota|billing/i;

/** The provider's own first line, short enough to quote. */
const said = (e: APICallError) => {
  const line = e.message.split("\n")[0]!.trim();
  return line ? ` The provider said: "${line.length > 160 ? line.slice(0, 159) + "…" : line}"` : "";
};

/** Classifies an error from a model call. Undefined: not a provider refusal, or one a retry can fix. */
export function providerFailure(e: unknown, provider: ProviderName): ProviderFailure | undefined {
  if (!APICallError.isInstance(e)) return undefined;
  const text = `${e.message}\n${e.responseBody ?? ""}`;
  const name = LABEL[provider];
  if (e.statusCode === 402 || NO_CREDITS.test(text)) {
    return {
      kind: "no_credits",
      message:
        `No credits left on the ${name} account behind this API key, so the model refused to answer. ` +
        `Add credits or raise the spending limit, then run again. Nothing was verified.${said(e)}`,
    };
  }
  if (e.statusCode === 401 || e.statusCode === 403) {
    return {
      kind: "bad_key",
      message: `${name} rejected the API key (HTTP ${e.statusCode}). Check the ${KEY_ENV[provider]} secret passed to Exhibit. Nothing was verified.${said(e)}`,
    };
  }
  if (e.statusCode === 404) {
    return {
      kind: "unknown_model",
      message: `${name} does not know this model, or this key may not use it (HTTP 404). Check model.name in .exhibit.yml. Nothing was verified.${said(e)}`,
    };
  }
  return undefined;
}

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * Wraps a model so that a refusal no retry can fix is thrown as a
 * ModelProviderError. Because it is no longer a retryable API error, the SDK
 * gives up on the first attempt instead of the third.
 */
export function withProviderErrors(model: LanguageModel, provider: ProviderName): LanguageModel {
  if (typeof model === "string") return model; // gateway ids: nothing to wrap
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate }) => {
      try {
        return await doGenerate();
      } catch (e) {
        const failure = providerFailure(e, provider);
        if (failure) throw new ModelProviderError(failure.kind, failure.message);
        throw e;
      }
    },
  };
  return wrapLanguageModel({ model: model as WrappableModel, middleware });
}

/** A model call that got no answer within the time limit (E12-8). */
export class ModelTimeoutError extends Error {
  constructor(ms: number) {
    super(`The model did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * E12-8: gives every model call a time limit. Without one, a connection that
 * hangs holds the whole run until the CI job is killed. The call is not
 * retried: a second and third hang would only multiply the wait.
 */
export function withCallTimeout(model: LanguageModel, ms: number): LanguageModel {
  if (typeof model === "string") return model;
  // The limit of each call, so that our own timeout can be told from the caller's abort.
  const limits = new WeakMap<object, AbortSignal>();
  const middleware: LanguageModelMiddleware = {
    transformParams: async ({ params }) => {
      const limit = AbortSignal.timeout(ms);
      const next = { ...params, abortSignal: params.abortSignal ? AbortSignal.any([params.abortSignal, limit]) : limit };
      limits.set(next, limit);
      return next;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (e) {
        if (limits.get(params)?.aborted) throw new ModelTimeoutError(ms);
        throw e;
      }
    },
  };
  return wrapLanguageModel({ model: model as WrappableModel, middleware });
}
