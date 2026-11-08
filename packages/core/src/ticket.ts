export interface TicketSources {
  branch?: string;
  prTitle?: string;
  prBody?: string;
}

/**
 * Finds the ticket key (e.g. PROJ-123). Order of precedence: PR title,
 * branch name, PR body — the title is the most deliberate signal.
 */
export function detectTicketKey(
  sources: TicketSources,
  pattern = "[A-Z][A-Z0-9]+-\\d+",
): string | undefined {
  const re = new RegExp(pattern);
  for (const text of [sources.prTitle, sources.branch, sources.prBody]) {
    if (!text) continue;
    // Branches are often lowercase: feature/proj-123-login
    const m = text.match(re) ?? text.toUpperCase().match(re);
    if (m) return m[0];
  }
  return undefined;
}
