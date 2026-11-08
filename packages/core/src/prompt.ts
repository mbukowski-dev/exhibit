import type { VerificationContext } from "./context.js";
import { isIgnoredPath } from "./diff.js";

/** Shared, stable rendering of the context for every LLM step. */
export function renderContext(ctx: VerificationContext, opts: { includeDiff?: boolean } = {}): string {
  const { ticket, criteria, changes } = ctx;
  const comments = ticket.comments
    .slice(-10)
    .map((c) => `- [${c.author}] ${c.body.replace(/\n+/g, " ").slice(0, 600)}`)
    .join("\n");
  const files = changes.files
    .filter((f) => !isIgnoredPath(f.path))
    .map((f) => `- ${f.status} ${f.path} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const parts = [
    `<ticket key="${ticket.key}">`,
    `Summary: ${ticket.summary}`,
    `Description:\n${ticket.description || "(empty)"}`,
    comments ? `Comments (latest last; later comments override earlier decisions):\n${comments}` : "",
    `</ticket>`,
    `<acceptance_criteria>`,
    criteria.map((c) => `${c.id}: ${c.text}`).join("\n") || "(none)",
    `</acceptance_criteria>`,
    `<changed_files>\n${files || "(none)"}\n</changed_files>`,
  ];
  if (opts.includeDiff !== false) {
    parts.push(`<diff${changes.truncated ? ' truncated="true"' : ""}>\n${changes.diff}\n</diff>`);
  }
  return parts.filter(Boolean).join("\n\n");
}
