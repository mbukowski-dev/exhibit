# Roadmap

Exhibit is an early preview. This is what works today and what comes next. Priorities follow what early
users run into — open an issue if something blocks you.

## Works today (v0.3)

- Tickets from **Jira** or a **Markdown file**; acceptance criteria from lists, a dedicated field, prose
  or Given/When/Then.
- Review of the PR diff against each acceptance criterion, with risk areas; large diffs are budgeted by
  relevance instead of being cut off.
- Browser scenarios per criterion, run by an agent on the preview deployment, with video, trace,
  screenshots, console errors and failed requests as evidence.
- Verdict per criterion (✅ 🟡 ❌ ⚠️), safeguards against unverified passes and loops, per-run cost cap.
- Evidence rules: every expected result needs its own check, a short fragment of a longer text does not count,
  "must NOT be shown" can be checked, and confirmation dialogs are accepted like a tester would.
- Requirement changes made in ticket comments are picked up and marked in the report.
- Pull requests without a ticket, from forks or from Dependabot are skipped instead of failing.
- Passing scenarios replayed without AI and turned into plain Playwright tests.
- GitHub Action: one PR comment updated in place, an "Exhibit" status, evidence as workflow artifacts.
- OpenAI or Anthropic with your own key; per-stage reasoning effort.
- Run diagnostics (`events.jsonl`, `summary.md`) for every run.

## Next

- **Acceptance criteria from the PR description or a linked GitHub issue** — no Jira token needed.
- Commit the generated tests from the PR with a `/accept-tests` comment.
- Comment commands: `/verify`, `/verify AC2`.
- Agent as a tool-calling conversation with prompt caching — faster and cheaper runs.
- Review that can open unchanged files in the repository, not only the diff.
- Screenshot (vision) fallback for UIs with a poor accessibility tree.
- Report back to the Jira ticket.

## Later

- MCP server, so coding agents (Claude Code, Cursor, …) can ask Exhibit "does my change meet PROJ-123?".
- Linear and GitHub Issues as trackers; GitLab.
- Ticket quality check before development ("no acceptance criterion for the error case").
- Mobile viewports and multiple user roles per scenario.
- A hosted option that doesn't require your own model key.
