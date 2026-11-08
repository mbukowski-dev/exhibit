import type { LanguageModel } from "ai";
import { z } from "zod";
import type { AcceptanceCriterion } from "./acceptance.js";
import { providerOptionsFor, type EffortConfig } from "./effort.js";
import type { Ticket } from "./jira.js";
import { generateObjectWithRetry } from "./llm.js";
import { UNTRUSTED_DATA_RULE } from "./prompt.js";

/**
 * Requirements often change in the ticket's comments ("PM: for unknown emails
 * show X instead"). The criteria list comes from the description, so without
 * this step Exhibit would verify an outdated requirement.
 *
 * The model proposes changes, but each one must quote the comment that makes
 * it, verbatim; a change whose quote is not found in that comment is dropped.
 */
const ReconcileSchema = z.object({
  changes: z
    .array(
      z.object({
        kind: z.enum(["changed", "added", "removed"]),
        acId: z.string().describe('Criterion id for "changed" / "removed" (e.g. AC3); empty for "added"'),
        newText: z.string().describe('Complete new criterion text for "changed" / "added"; empty for "removed"'),
        comment: z.number().int().describe("Number of the comment that makes this change (#1, #2, … as listed)"),
        quote: z.string().describe("The exact words from that comment that state the change, copied verbatim"),
      }),
    )
    .max(10),
});

const SYSTEM = `You compare a ticket's acceptance criteria with the discussion in its comments.
Report only changes that a comment clearly DECIDES: a criterion is changed, a new one is added, or one is dropped.
Ignore questions, open proposals, disagreements that were not resolved, and comments about implementation details.
When comments conflict, the later decision wins.
For every change, copy the exact words from the comment that state it (verbatim, no paraphrasing).
If nothing changed, return an empty list. Keep the language of the ticket.
${UNTRUSTED_DATA_RULE}`;

const MAX_COMMENTS = 20;
const MAX_COMMENT_CHARS = 2_000;

const norm = (s: string) => s.toLowerCase().replace(/[\s"'“”„«»]+/g, " ").trim();

export interface ReconcileResult {
  criteria: AcceptanceCriterion[];
  /** Human-readable notes for the report ("AC3 changed in a comment by Anna …"). */
  notes: string[];
  /** Proposed changes rejected because their quote was not found. */
  rejected: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function reconcileWithComments(
  ticket: Ticket,
  criteria: AcceptanceCriterion[],
  model: LanguageModel,
  effort?: EffortConfig,
): Promise<ReconcileResult> {
  const comments = ticket.comments.slice(-MAX_COMMENTS);
  if (!comments.length) return { criteria, notes: [], rejected: 0 };

  const prompt = [
    `<ticket key="${ticket.key}">`,
    `Summary: ${ticket.summary}`,
    `<acceptance_criteria>\n${criteria.map((c) => `${c.id}: ${c.text}`).join("\n") || "(none)"}\n</acceptance_criteria>`,
    `<comments>`,
    ...comments.map((c, i) => `#${i + 1} [${c.author}, ${c.created.slice(0, 10)}]\n${c.body.slice(0, MAX_COMMENT_CHARS)}`),
    `</comments>`,
    `</ticket>`,
  ].join("\n\n");

  const { object, usage } = await generateObjectWithRetry({
    model,
    schema: ReconcileSchema,
    system: SYSTEM,
    prompt,
    providerOptions: providerOptionsFor("infer", effort),
  });
  return { ...applyChanges(criteria, comments, object.changes), usage };
}

/** Deterministic part: validates quotes and applies the accepted changes. */
export function applyChanges(
  criteria: AcceptanceCriterion[],
  comments: Ticket["comments"],
  changes: z.infer<typeof ReconcileSchema>["changes"],
): Omit<ReconcileResult, "usage"> {
  let out = criteria.map((c) => ({ ...c }));
  const notes: string[] = [];
  let rejected = 0;
  let next = criteria.reduce((m, c) => Math.max(m, Number(c.id.replace(/\D/g, "")) || 0), 0);

  for (const ch of changes) {
    const comment = comments[ch.comment - 1];
    const quote = ch.quote.trim();
    if (!comment || quote.length < 3 || !norm(comment.body).includes(norm(quote))) {
      rejected++;
      continue;
    }
    const by = { author: comment.author, created: comment.created, quote };
    const when = comment.created.slice(0, 10);
    const id = ch.acId.toUpperCase().trim();

    if (ch.kind === "added" && ch.newText.trim()) {
      const ac: AcceptanceCriterion = { id: `AC${++next}`, text: ch.newText.trim(), source: "comment", changedBy: by };
      out.push(ac);
      notes.push(`${ac.id} added in a comment by ${by.author} (${when}): “${quote}”`);
    } else if (ch.kind === "changed" && ch.newText.trim()) {
      const ac = out.find((c) => c.id === id);
      if (!ac) { rejected++; continue; }
      ac.changedBy = { ...by, previousText: ac.changedBy?.previousText ?? ac.text };
      ac.text = ch.newText.trim();
      notes.push(`${ac.id} changed in a comment by ${by.author} (${when}): “${quote}”`);
    } else if (ch.kind === "removed") {
      if (!out.some((c) => c.id === id)) { rejected++; continue; }
      out = out.filter((c) => c.id !== id);
      notes.push(`${id} dropped in a comment by ${by.author} (${when}): “${quote}” — not verified`);
    } else {
      rejected++;
    }
  }
  return { criteria: out, notes, rejected };
}
