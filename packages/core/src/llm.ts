import { generateObject, NoObjectGeneratedError } from "ai";
import type { z } from "zod";

type GenerateArgs<T extends z.ZodTypeAny> = {
  model: Parameters<typeof generateObject>[0]["model"];
  schema: T;
  system: string;
  prompt: string;
  providerOptions?: Record<string, Record<string, unknown>>;
};

/**
 * generateObject with one corrective retry when the answer does not match
 * the schema. One bad answer must not kill a whole run (self-test run 4:
 * a good plan was lost because one field broke a constraint).
 * Usage of both attempts is reported.
 */
export async function generateObjectWithRetry<T extends z.ZodTypeAny>(
  args: GenerateArgs<T>,
  onRetry?: (error: string) => void,
): Promise<{ object: z.infer<T>; usage: { inputTokens?: number; outputTokens?: number } }> {
  try {
    const r = await generateObject(args as any);
    return { object: r.object as z.infer<T>, usage: r.usage };
  } catch (e) {
    if (!NoObjectGeneratedError.isInstance(e)) throw e;
    const detail = (e.cause as Error | undefined)?.message?.slice(0, 600) ?? e.message;
    onRetry?.(detail);
    const r = await generateObject({
      ...(args as any),
      prompt: `${args.prompt}\n\n<exhibit_notice>\nYour previous answer did not match the required schema: ${detail}\nAnswer again, following the schema exactly.\n</exhibit_notice>`,
    });
    return {
      object: r.object as z.infer<T>,
      usage: {
        inputTokens: (e.usage?.inputTokens ?? 0) + (r.usage.inputTokens ?? 0),
        outputTokens: (e.usage?.outputTokens ?? 0) + (r.usage.outputTokens ?? 0),
      },
    };
  }
}
