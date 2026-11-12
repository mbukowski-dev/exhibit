import type { LanguageModel } from "ai";
import { extractAcceptanceCriteria, inferAcceptanceCriteria, type AcceptanceCriterion } from "./acceptance.js";
import type { ExhibitConfig } from "./config.js";
import type { ChangeSet } from "./diff.js";
import type { Ticket } from "./jira.js";
import { budgetDiff } from "./diff-budget.js";
import { reconcileWithComments } from "./reconcile.js";
import { detectTicketKey } from "./ticket.js";
import type { UsageMeter } from "./usage.js";

export interface VerificationContext {
  ticket: Ticket;
  criteria: AcceptanceCriterion[];
  changes: ChangeSet;
  warnings: string[];
  /** .exhibit.yml agent_notes: facts about the test environment, given to every stage. */
  notes?: string;
  /** .exhibit.yml language: "auto" (follow the ticket) or the language to write in. */
  language?: string;
}

export interface BuildContextOptions {
  config: ExhibitConfig;
  changes: ChangeSet;
  /** Explicit ticket key; otherwise detected from the PR title / branch. */
  ticketKey?: string;
  /** Used when neither `ticketKey` nor detection yields a key (e.g. a ticket file's name). */
  fallbackTicketKey?: string;
  fetchTicket: (key: string) => Promise<Ticket>;
  /** When provided, used to infer AC that are not written down explicitly. */
  model?: LanguageModel;
  meter?: UsageMeter;
  /** Characters of diff sent to the model (default 120k). */
  diffBudgetChars?: number;
}

/** No ticket key in the PR title, branch or description: nothing to verify against. */
export class NoTicketKeyError extends Error {}

export async function buildContext(opts: BuildContextOptions): Promise<VerificationContext> {
  const warnings: string[] = [];
  const key =
    opts.ticketKey ??
    detectTicketKey(
      { prTitle: opts.changes.title, branch: opts.changes.branch, prBody: opts.changes.body },
      opts.config.ticket_pattern,
    ) ??
    opts.fallbackTicketKey;
  if (!key) {
    throw new NoTicketKeyError(
      `No ticket key found in PR title "${opts.changes.title ?? ""}" or branch "${opts.changes.branch ?? ""}". ` +
        `Pass --ticket or name the branch like feature/PROJ-123-short-name.`,
    );
  }

  const ticket = await opts.fetchTicket(key);
  let criteria = extractAcceptanceCriteria(ticket, { headings: opts.config.acceptance_headings });

  if (!criteria.length) {
    if (opts.model) {
      opts.meter?.assertBudget("infer acceptance criteria");
      const inferred = await inferAcceptanceCriteria(ticket, opts.model, opts.config.model.effort);
      opts.meter?.add("infer-ac", inferred.usage);
      criteria = inferred.criteria;
      warnings.push(`${key} has no explicit acceptance criteria; ${criteria.length} were inferred by the model — review them.`);
    } else {
      warnings.push(`${key} has no explicit acceptance criteria (no model key set, so none were inferred).`);
    }
  } else if (opts.model && ticket.comments.length) {
    // Criteria come from the description; later comments may have changed them.
    // (Inferred criteria already took the comments into account.)
    opts.meter?.assertBudget("reconcile criteria with comments");
    const r = await reconcileWithComments(ticket, criteria, opts.model, opts.config.model.effort);
    opts.meter?.add("reconcile-ac", r.usage);
    criteria = r.criteria;
    warnings.push(...r.notes);
    if (r.rejected) warnings.push(`${r.rejected} proposed requirement change(s) from comments were ignored: the quoted words were not found in the comment.`);
  }
  // E11-3: fit the diff into the model budget by relevance to the criteria.
  const budget = budgetDiff(opts.changes.diff, {
    maxChars: opts.diffBudgetChars,
    relevanceText: [ticket.summary, ...criteria.map((c) => c.text)].join("\n"),
  });
  const changes = { ...opts.changes, diff: budget.diff, truncated: opts.changes.truncated || budget.truncated };
  if (opts.changes.truncated) warnings.push("The diff exceeded the 2 MB fetch limit; the review may miss changes.");
  if (budget.omitted.length || budget.shortened.length) {
    const parts = [
      budget.omitted.length && `${budget.omitted.length} lower-priority file(s) left out (${budget.omitted.slice(0, 5).join(", ")}${budget.omitted.length > 5 ? ", …" : ""})`,
      budget.shortened.length && `${budget.shortened.length} large file(s) shortened`,
    ].filter(Boolean);
    warnings.push(`Large diff: ${parts.join("; ")}. Files related to the acceptance criteria were kept first.`);
  }
  if (!opts.changes.files.length) warnings.push("No changed files found.");

  return { ticket, criteria, changes, warnings, notes: opts.config.agent_notes?.trim() || undefined, language: opts.config.language };
}
