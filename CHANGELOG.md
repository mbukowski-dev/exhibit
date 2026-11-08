# Changelog

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
