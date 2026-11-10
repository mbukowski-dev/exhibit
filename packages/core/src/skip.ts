/**
 * E12-2: pull requests Exhibit cannot or need not verify. They end the CI run
 * quietly (a notice, a green "Skipped" status where the token allows it)
 * instead of a failed job and an error comment on every Dependabot bump.
 */
export interface Skip {
  reason: "no_secrets" | "no_ticket";
  /** Commit status description (GitHub allows 140 characters). */
  status: string;
  /** One line for the workflow log and summary. */
  notice: string;
}

/** True when the pull request's branch lives in another repository (or that repository is gone). */
export function isForkPullRequest(event: any): boolean {
  const base = event?.pull_request?.base?.repo?.full_name;
  if (!base) return false; // not enough to tell: do not guess
  return event.pull_request.head?.repo?.full_name !== base;
}

export function skipReason(i: {
  /** The GitHub Actions event payload. */
  event: any;
  /** GITHUB_ACTOR: who triggered the run. */
  actor?: string;
  hasModelKey: boolean;
  /** A ticket key was found (PR title, branch, body) or a ticket file is used. */
  hasTicket: boolean;
}): Skip | undefined {
  if (!i.hasModelKey) {
    // GitHub passes no repository secrets to these runs, so the key cannot be there.
    // On the team's own pull request a missing key is a setup mistake and must stay loud.
    const who = isForkPullRequest(i.event) ? "a fork" : (i.actor ?? i.event?.sender?.login) === "dependabot[bot]" ? "Dependabot" : undefined;
    if (!who) return undefined;
    return {
      reason: "no_secrets",
      status: `Skipped: pull requests from ${who} get no secrets`,
      notice: `Exhibit did not run: GitHub does not pass repository secrets to pull requests from ${who}, so there is no model key. Nothing was verified and nothing was spent.`,
    };
  }
  if (!i.hasTicket) {
    return {
      reason: "no_ticket",
      status: "Skipped: no ticket key in the pull request title or branch",
      notice:
        "Exhibit did not run: no ticket key in the pull request title, branch or description. " +
        "To verify this pull request, name the branch like feature/PROJ-123-short-name or start the title with PROJ-123.",
    };
  }
  return undefined;
}
