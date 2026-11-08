import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Ticket } from "./jira.js";

/**
 * Offline ticket source: a Markdown file whose first `# heading` is the
 * summary and the rest is the description. Handy for demos, evals and
 * teams without Jira access in CI.
 */
export async function ticketFromFile(path: string, key?: string): Promise<Ticket> {
  const text = await readFile(path, "utf8");
  return parseTicketMarkdown(text, key ?? basename(path).replace(/\.[^.]+$/, ""));
}

export function parseTicketMarkdown(text: string, key: string): Ticket {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  const summary = idx >= 0 ? lines[idx]!.replace(/^#\s+/, "").trim() : key;
  const description = (idx >= 0 ? lines.slice(idx + 1) : lines).join("\n").trim();
  return { key, url: "", summary, type: "", status: "", description, comments: [] };
}
