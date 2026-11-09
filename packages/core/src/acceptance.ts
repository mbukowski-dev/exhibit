import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Ticket } from "./jira.js";
import { providerOptionsFor, type EffortConfig } from "./effort.js";

export interface AcceptanceCriterion {
  id: string; // AC1, AC2, ...
  text: string;
  source: "field" | "section" | "gherkin" | "llm" | "comment";
  /** Set when a later ticket comment changed (or added) this criterion. */
  changedBy?: { author: string; created: string; quote: string; previousText?: string };
}

const SECTION_HEADING =
  /^\s*(?:#+\s*|\*+)?\s*(acceptance criteria|acceptance|kryteria akceptacji|definition of done|AC)\s*:?\s*\**\s*$/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+(.*\S)\s*$/;
const ANY_HEADING = /^\s*#+\s+\S/;
const GHERKIN_START = /^\s*(?:scenario|given|scenariusz|zakładając)\b/i;

function number(items: string[], source: AcceptanceCriterion["source"]): AcceptanceCriterion[] {
  return items.map((text, i) => ({ id: `AC${i + 1}`, text, source }));
}

/** Width of the leading whitespace; a tab counts as one nesting level (2 spaces, as adfToText indents). */
const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, "  ").length;

/**
 * Pulls list items out of a block of text (stops at the next heading).
 * Nested items are details of their parent, not separate criteria, so they are
 * appended to it: "Columns: a, b" + "  - amounts use a decimal comma" is one AC.
 */
function listItems(lines: string[]): string[] {
  const items: string[] = [];
  let topIndent = -1;
  for (const line of lines) {
    if (ANY_HEADING.test(line) && items.length) break;
    const m = line.match(LIST_ITEM);
    if (m?.[1]) {
      const text = m[1].replace(/^\[[ xX]?\]\s*/, "").trim();
      const indent = indentOf(line);
      if (topIndent < 0) topIndent = indent;
      if (indent > topIndent && items.length) {
        const parent = items[items.length - 1]!;
        items[items.length - 1] = parent + (/[:;,]$/.test(parent) ? " " : "; ") + text;
      } else items.push(text);
    } else if (line.trim() && items.length && /^\s{2,}\S/.test(line)) {
      items[items.length - 1] += " " + line.trim(); // wrapped continuation
    }
  }
  return items;
}

const SCENARIO = /^\s*(scenario|scenariusz)\b/i;
const GIVEN = /^\s*(given|zakładając)\b/i;
const STEP = /^\s*(given|when|then|and|but|zakładając|gdy|wtedy|oraz)\b/i;
const THEN = /\b(then|wtedy)\b/i;

/** One block per scenario; a new block starts at "Scenario:" or at a "Given" after a "Then". */
function gherkinScenarios(text: string): string[] {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const startsNew = SCENARIO.test(line) || (GIVEN.test(line) && (!current || current.some((l) => THEN.test(l))));
    if (startsNew) blocks.push((current = [line.trim()]));
    else if (current && STEP.test(line)) current.push(line.trim());
  }
  return blocks.map((b) => b.join(" ")).filter((b) => THEN.test(b));
}

/**
 * Deterministic extraction. Order: dedicated custom field, an
 * "Acceptance Criteria" section in the description, Gherkin scenarios.
 * Returns [] when nothing obvious is found — callers may fall back to the LLM.
 */
export function extractAcceptanceCriteria(ticket: Ticket): AcceptanceCriterion[] {
  if (ticket.acceptanceField?.trim()) {
    const items = listItems(ticket.acceptanceField.split("\n"));
    if (items.length) return number(items, "field");
    return number([ticket.acceptanceField.trim()], "field");
  }

  const lines = ticket.description.split("\n");
  const start = lines.findIndex((l) => SECTION_HEADING.test(l));
  if (start >= 0) {
    const items = listItems(lines.slice(start + 1));
    if (items.length) return number(items, "section");
  }

  if (lines.some((l) => GHERKIN_START.test(l))) {
    const scenarios = gherkinScenarios(ticket.description);
    if (scenarios.length) return number(scenarios, "gherkin");
  }
  return [];
}

const LlmAcSchema = z.object({
  criteria: z
    .array(z.string().describe("One testable acceptance criterion, phrased as observable behaviour"))
    .max(15),
});

/** LLM fallback for tickets where AC are implied in prose. */
export async function inferAcceptanceCriteria(
  ticket: Ticket,
  model: LanguageModel,
  effort?: EffortConfig,
): Promise<{ criteria: AcceptanceCriterion[]; usage?: { inputTokens?: number; outputTokens?: number } }> {
  const comments = ticket.comments
    .slice(-10)
    .map((c) => `[${c.author}] ${c.body}`)
    .join("\n");
  const { object, usage } = await generateObject({
    model,
    schema: LlmAcSchema,
    system:
      "You extract acceptance criteria from software tickets. Output only criteria a tester could verify " +
      "in the running application or code. Do not invent requirements that are not stated or clearly implied. " +
      "Later comments override earlier description when they conflict. Keep the ticket's language.",
    prompt: `Ticket ${ticket.key}: ${ticket.summary}\n\nDescription:\n${ticket.description || "(empty)"}\n\nComments:\n${comments || "(none)"}`,
    providerOptions: providerOptionsFor("infer", effort),
  });
  return { criteria: number(object.criteria, "llm"), usage };
}
