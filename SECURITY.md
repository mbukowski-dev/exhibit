# Security and responsible use

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Report them privately through GitHub: **Security → Report a vulnerability** on this repository.
You will get an answer within 5 working days. Please give us a reasonable time to fix the issue before
disclosing it.

## Run Exhibit only against test environments

Exhibit's browser agent **clicks, types and submits forms** in the application it verifies. It does what
the scenario needs, and it can reach anything a user of that environment can reach.

- Point it at **preview, staging or local environments with test data only** — never at production.
- Use **dedicated test accounts** with the least privileges the scenarios need. Never use real customer
  or admin accounts.
- Assume that anything reachable in that environment may be clicked: delete buttons, payments,
  outgoing emails or webhooks. Disable or sandbox those in preview environments (test payment keys,
  a mail catcher, no production integrations).

## What is sent to your model provider

Exhibit runs with **your own API key** (Anthropic or OpenAI). For each run it sends to that provider:

- the ticket (summary, description, acceptance criteria, recent comments),
- the pull request diff (budgeted, see `.exhibit.yml`),
- accessibility snapshots of the pages it visits in your test environment.

It does **not** send credentials: the agent types `{{username}}` / `{{password}}` placeholders and Exhibit
substitutes the real values inside the browser, and redacts them from anything sent back to the model,
logs and reports. Review your provider's data-retention terms before using Exhibit on private code.

## Secrets in GitHub Actions

- Store keys and test-account credentials as **repository secrets**; never commit them.
- Pull requests from **forks do not receive secrets**, so Exhibit cannot run (or spend your API budget)
  on them.
- **Pin the action to a full commit SHA** (`mbukowski-dev/exhibit@<40-character sha>  # v0.3.0`), never to
  `@main` or a bare tag. The action runs with your secrets. A commit SHA cannot be changed by anyone —
  including us, or someone who took over our account — so you only ever run code you chose. Update the SHA
  deliberately (Dependabot can propose it).
- Exhibit itself pins every third-party action it uses to a commit SHA and installs dependencies from a
  lockfile with integrity hashes (`pnpm install --frozen-lockfile`).
- Give the workflow only the permissions it needs: `contents: read`, `pull-requests: write`,
  `statuses: write`.
- Set a spending limit on the API key's project at your provider, in addition to
  `model.max_cost_per_run_usd` in `.exhibit.yml` (default $1.50 per run).

## Limit the blast radius of every key

Give Exhibit keys that would do little harm even if they leaked:

| Secret | Recommended setup |
|---|---|
| Model API key | A **separate project/key only for Exhibit**, with a **monthly budget limit** at the provider |
| Jira token | Token of a **read-only bot account** that sees only the projects to verify |
| Test-account login | An account that exists **only in the test environment**, with test data |
| `GITHUB_TOKEN` | Provided by GitHub per run and expires with it; grant only the permissions listed above |

Optionally restrict the runner's outbound network to the hosts Exhibit needs (your preview URL, your model
provider, your Jira, GitHub) with an egress-filtering action.

## Untrusted content (prompt injection)

Ticket text, pull request content and the pages under test are untrusted input to the model. Exhibit
limits what a manipulated model can do:

- the browser blocks every top-level navigation outside the app under test — typed URLs, clicked links,
  form submits and redirects alike (extra origins such as an SSO page must be listed in `allowed_origins`);
- credentials never enter the model's context, and are only ever typed on the app's own origin;
- text from the model, the pages and the ticket is neutralized before it goes into the PR comment
  (no @mentions, HTML, images or links);
- a ✅ is only accepted after the agent verified the expected result on the page (`assert`), and a ❌
  only with browser evidence;
- per-run cost and step limits stop runaway runs.

Treat Exhibit's verdicts as **evidence for a human reviewer**, not as a replacement for review. The default
`mode: comment` never blocks merging.

## Artifacts and logs

Playwright traces record every typed value, so **Exhibit does not record a trace for runs that use
credentials** (videos and screenshots are still kept; password fields stay masked in them).

Videos, traces, screenshots and diagnostics (`events.jsonl`, `summary.md`, and full prompts with
`debug: true`) are uploaded as workflow artifacts. In **public repositories they are visible to anyone**
who can see the workflow run. Keep `debug` off and use test data only.
