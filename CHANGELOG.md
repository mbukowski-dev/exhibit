# Changelog

## Unreleased

- `agent_notes` from `.exhibit.yml` now reach the review and the planner, not only the browser agent. The
  planner uses the test accounts and data you name, and a step the notes rule out ("never submit the payment
  form") is reported as not testable instead of being planned. Notes cannot remove an acceptance criterion.
- Pull requests Exhibit cannot or need not verify no longer fail the job. Without a ticket key in the title,
  branch or description the run is skipped with a green "Skipped" status and no comment (before: an error
  status, a ⛔ comment and a failed job, after waiting for the preview). Pull requests from forks and from
  Dependabot, which get no secrets from GitHub, are skipped with a notice. A missing model key on your own
  pull request is still an error. The action's `verdict` output is `skipped` in these cases.
- A ✅ needs evidence for every expected result: when a scenario expects several things, the browser agent must
  check each of them with its own assert before it may report a pass. Before, one successful assert of
  anything on the page was enough.
- Asserts no longer accept a short fragment of a longer text: "account found" used to pass on a page that says
  "No account found for this email". The text must be the complete text of an element, or at least four
  words of it; otherwise the agent is shown what the page really says. An assert with no text, or with a role
  and a value but no name, no longer matches everything.
- New `assert_absent` check for criteria that say something must NOT be shown (no error message, no hint
  whether an account exists). It only counts after a positive check on the same page, and generated
  Playwright tests include it.
- Browser dialogs (`confirm`, `alert`, `prompt`) are accepted, the way a tester clicking OK would, and their
  text is shown to the browser agent. Before, an unhandled dialog was dismissed, so a "Delete" behind a
  confirmation silently did nothing and a working app could be reported as not meeting a criterion.
  Generated Playwright tests accept the dialogs the recorded run saw.

## 0.3.3

- A failed criterion needs evidence about the app: a "fail" seen on an error page (HTTP 4xx/5xx) at a URL the
  browser agent typed in itself, rather than found in the app or named by the scenario, is reported as not
  verified instead. The agent and the planner are also told not to guess URLs or tokens, and to treat steps
  that need an e-mail, a token or time passing as not testable in the browser.

## 0.3.2

- Nested list items in an acceptance criteria section are folded into their parent criterion instead of
  becoming separate criteria.
- Jira ticket titles are trimmed, so a title pasted with a trailing newline no longer breaks the output.
- Clearer Jira errors: a wrong e-mail or API token is reported as such (Jira Cloud answers it with
  "not found"), and a wrong or unreachable `JIRA_BASE_URL` or a malformed ticket key gets its own message.
- Docs: the example workflows cancel a run still going when a new commit is pushed to the PR (one paid run
  per PR instead of one per push) and set a job timeout; SECURITY.md notes that the PR comment quotes the
  ticket, so it is public in public repositories.

## 0.3.1

- The GitHub account moved to `mbukowski-dev`: repository links, the action reference and the license contact
  address now point to https://github.com/mbukowski-dev/exhibit.

## 0.3.0

- Acceptance criteria are reconciled with later ticket comments (each change quotes the comment and is verified).
- `exhibit --version` reads the version from package.json, so it always matches the release.
- The pull request title and description are given to the model as the developer's claim; ticket, PR and diff text are treated as data, never as instructions.

## 0.2.1 — first public version

- License: Business Source License 1.1 — free for personal use, open source projects and one private
  repository per organization (up to 10 contributors); each version becomes Apache 2.0 four years after publication.

## 0.1.x — private previews

Versions 0.1.0–0.1.2 were private previews and are not published. Their changes are summarized below.

### 0.1.2 — security review fixes

- Navigation guard: every top-level navigation outside the app under test is blocked; `allowed_origins` for SSO.
- Credentials are typed only on allowed origins; no trace is recorded when credentials are in play.
- Untrusted text in the PR comment is neutralized.
- Dependencies updated: 0 known vulnerabilities.

### 0.1.1 — supply-chain hardening

- Every third-party action used by Exhibit is pinned to a full commit SHA.
- Documentation pins Exhibit itself to a commit SHA; SECURITY.md covers least-privilege keys.

### 0.1.0 — first preview

Verifies that a pull request does what its ticket promised, with evidence.

- Reads the ticket (Jira or a Markdown file), its acceptance criteria and the PR diff.
- Spec-aware review: which acceptance criteria the diff implements, and which areas it puts at risk.
- Plans browser scenarios per acceptance criterion and runs them with a browser agent (Playwright,
  accessibility tree), recording video, trace and screenshots.
- Verdict per criterion: ✅ verified, 🟡 partly verified, ❌ not met (browser evidence only), ⚠️ needs a human.
- Passed scenarios are replayed without AI and turned into plain Playwright tests.
- GitHub Action: one PR comment updated in place, an "Exhibit" status, evidence as workflow artifacts.
- Bring your own key: Anthropic or OpenAI; per-run cost cap; credentials never reach the model.
- Run diagnostics: every model call and browser action in `events.jsonl` and `summary.md`.
