# Exhibit

**Verifies that a pull request does what its ticket promised — with evidence.**

![Exhibit checks a pull request against its ticket: the browser agent finds that an unknown email reveals "No account found", so AC3 is not met](docs/media/exhibit-demo.gif)

<sub>Animation built from the screenshots and results of a real run on the demo app in this repository.</sub>

AI writes code faster than teams can check it. Code-review bots read the diff and comment on the code,
but nobody answers the question that matters before merging: *does the running app now do what the
ticket asked for?*

Exhibit answers it on every pull request. It reads the ticket and its acceptance criteria, opens the
PR's preview deployment in a real browser, checks each criterion like a tester would, and posts one
comment with a verdict and proof — video, screenshots and a replayable trace.

## Why

Coding agents are starting to write most of the code. Reviewing changes shifts from *"is this line
right?"* to *"is this what we asked for?"* — and that question is still answered by hand, if at all.

Exhibit's goal is simple: **every change arrives with evidence that it does what was asked.** Acceptance
criteria stop being text in a ticket and become checks that run on every pull request. The ones that pass
turn into ordinary tests that stay in your repository. People review intent and evidence instead of
re-clicking through every change.

Exhibit is not a code-style reviewer (other tools do that well), not a framework you write tests in, and
not a replacement for the people who approve a merge — it gives them proof to decide on.

> **Early preview (v0.3).** Works end to end on GitHub; tested so far on a demo app and a real Jira Cloud
> site. If you'd like to try it on your project, open an issue — early users get hands-on help with the setup.

## What you get in the pull request

A real comment from this repository's [self-test](https://github.com/mbukowski-dev/exhibit/pull/1), shortened:

> ### Exhibit · PROJ-123 Password reset via email
> **❌ Acceptance criteria not met** — 1/4 acceptance criteria verified, 1 partly
>
> | | Acceptance criterion | Evidence |
> |---|---|---|
> | ✅ | **AC1** "Forgot password?" link is visible on the login page | Link present; clicking it opens the reset form with an Email field and a "Send reset link" button. |
> | 🟡 | **AC2** A registered email shows "Check your inbox" and sends a reset email | "Check your inbox" shown. *Not verified:* email delivery cannot be checked in a browser. |
> | ❌ | **AC3** An unknown email shows the same message (no account enumeration) | After submitting nobody@example.com the page shows **"No account found for this email"** — it reveals which accounts exist. |
> | ⚠️ | **AC4** The reset link expires after 30 minutes | Needs a human: cannot be verified in a normal browser session. |
>
> ▸ Code review against the ticket · ▸ Scenarios · ▸ 🧪 2 generated Playwright tests
>
> 📎 Videos & traces · $0.10 · 1m 40s

**How to read it:** ✅ verified in the browser · 🟡 the visible part works, the rest can't be checked in a
browser · ❌ the app behaves differently than the ticket says (never given without browser evidence) ·
⚠️ a human needs to look.

## What sets it apart

- **Nothing to write.** No test code and no test framework to learn: the checks come from the acceptance
  criteria your team already writes.
- **Evidence, not an opinion.** Every verdict comes with what the browser saw: video and screenshots. A ❌ is
  only given for something seen in the running app, and a ✅ only after every expected result was checked.
- **It says what it could not check.** E-mail delivery, a link that expires in 30 minutes, anything a browser
  cannot see is marked ⚠️ for a human instead of being guessed.
- **You keep the tests.** Passing scenarios become plain Playwright tests, ready to commit. They run without
  Exhibit and without AI.
- **Your language.** The review, the scenarios and the findings follow the language of each ticket, or one
  language you choose (`language: pl`) whatever the tickets are written in. Text quoted from your app is never
  translated. Your own heading for the criteria section ("Akzeptanzkriterien") is one line of configuration.
- **It stays out of the way.** It runs in your GitHub Actions with your own model key, and nothing is stored on
  our side. Pull requests without a ticket are skipped, and by default it only comments.
- **Good defaults, and every one of them is yours to change.** It runs without a configuration file. The
  language, the model and how hard it thinks at each stage, the cost cap, the time limits, how many scenarios
  it runs and whether it may block a merge are each one line in `.exhibit.yml` —
  [every setting with its default](docs/configuration.md).

## How it works

1. **Reads the ticket** (Jira, or a Markdown file) and extracts the acceptance criteria — also from prose
   or Given/When/Then.
2. **Reviews the diff against the ticket** — which criteria the change implements, what else it could break.
   Not style or naming: other tools do that.
3. **Plans browser scenarios** for every criterion, including edge cases, and marks what a browser can't check.
4. **Runs them with a browser agent** on your preview deployment: it reads the page's accessibility tree,
   clicks and types, and must *see* the expected result before it may report ✅.
5. **Turns passing scenarios into plain Playwright tests**, replayed once without AI, that you can commit —
   next time no AI is needed, and there's no lock-in.

## Set it up on a repository (about 15 minutes)

**You need:** a web app on GitHub with a **preview deployment per pull request** (Vercel, Netlify or your
own), tickets with acceptance criteria in **Jira**, and an **OpenAI or Anthropic API key**.

Add `.github/workflows/exhibit.yml` — full example and options in **[docs/github-action.md](docs/github-action.md)**:

```yaml
on: pull_request
permissions: { contents: read, pull-requests: write, statuses: write }
concurrency: { group: "exhibit-${{ github.event.pull_request.number }}", cancel-in-progress: true }  # one paid run per PR, not per push
jobs:
  exhibit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
      - uses: mbukowski-dev/exhibit@a403a995f80711e52bf30a504d46693d952f9d1d  # v0.3.4
        with:
          preview-url: https://myapp-git-{branch}-acme.vercel.app
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          jira-base-url: https://acme.atlassian.net
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
```

Name the branch or PR title after the ticket (`feature/PROJ-123-…` or `PROJ-123: …`) and open a pull
request. Pull requests without a ticket key are skipped. By default Exhibit only comments; `mode: check` can
block merging once you trust it.

**Cost and time:** you pay your model provider directly. On the demo app a run takes about 2 minutes and
costs about $0.10 with `gpt-5`; real apps with more criteria cost more. Every run has a hard cap
(`max_cost_per_run_usd`, default $1.50).

### No Jira, or no preview deployment per pull request?

- **No Jira, or just trying it out:** write the ticket as a Markdown file — a `# title` and an
  `## Acceptance Criteria` list, like [examples/PROJ-123.md](examples/PROJ-123.md) — commit it, and replace the
  three `jira-*` inputs with `ticket-file: path/to/ticket.md`. That is enough for a first run on one pull
  request; for everyday use connect Jira. Criteria from the pull request description or a GitHub issue are
  next on the [roadmap](ROADMAP.md).
- **No preview deployment per pull request:** `preview-url` can be any address where the pull request's code is
  running, for example a staging server you deploy the branch to (`preview-url: https://staging.myapp.com`).
  Exhibit checks whatever is deployed there, so make sure it is the pull request's code — otherwise the verdict
  is about a different version. You can also run it from your own machine against the app running locally: see
  [Try it locally](#try-it-locally).

## Configuration (`.exhibit.yml`, optional)

Nothing here is required. The most common settings are below; **[docs/configuration.md](docs/configuration.md)**
lists every setting with its default and what it changes.

```yaml
preview_url: "https://pr-{pr}.myapp.vercel.app"   # {pr}, {branch}, {sha} are filled in
language: auto                     # auto = the ticket's language; or pl, Polish, de, Deutsch, …
model:
  provider: openai                 # openai | anthropic — picked automatically from the key you set
  max_cost_per_run_usd: 1.5
mode: comment                      # comment (advisory) | check (fails the status on ❌)
max_scenarios: 8
agent_notes: |                     # your test environment: accounts, seed data, what not to touch
  Registered test account: ana@example.com
auth:                              # if the app needs a login
  - role: user
    username_env: EXHIBIT_USERNAME # values come from GitHub secrets
    password_env: EXHIBIT_PASSWORD
    login_flow: ./e2e/login.ts     # optional: your own login script
allowed_origins: []                # other sites the browser may open, e.g. an SSO login page
```

## Try it locally

Requires Node.js 22+ and pnpm.

```bash
git clone https://github.com/mbukowski-dev/exhibit && cd exhibit
pnpm install && pnpm --filter @exhibit/core exec playwright install chromium
cp .env.example .env                       # add OPENAI_API_KEY or ANTHROPIC_API_KEY

node examples/demo-app/server.mjs &        # demo app with a deliberate bug, http://localhost:4173
pnpm exhibit verify --ticket-file examples/PROJ-123.md --url http://localhost:4173 --headed -v
```

Other commands: `exhibit context` (what Exhibit would verify, no AI), `exhibit plan` (review and plan,
no browser). Evidence and run diagnostics are written to `exhibit-artifacts/`.

**On your own app:** start your app locally from the branch you want to check, then point Exhibit at your
repository with `-C`. It compares the branch with `main` (`-b` for another base branch):

```bash
pnpm exhibit context -C ../your-app --ticket-file ../your-app/ticket.md --no-llm   # free: shows what would be verified
pnpm exhibit verify  -C ../your-app --ticket-file ../your-app/ticket.md --url http://localhost:3000
```

With Jira, add `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` to `.env` and use `-t PROJ-123` instead of
`--ticket-file`.

## What it can't do yet

- **Trackers and code hosts:** Jira Cloud and Markdown ticket files, on GitHub. Jira Server / Data Center,
  Linear, GitHub Issues and GitLab are not supported yet.
- **Browser:** Chromium at a desktop size (1280×720), in one tab. Links that open a new tab, file uploads,
  drag and drop and menus that only open on hover are not handled yet.
- **Pages:** it reads the page's accessibility tree, so canvas-based or poorly labelled interfaces are hard for
  it. A screenshot fallback is on the roadmap.
- **What a browser can't see:** e-mails, time passing, other systems. These are reported as ⚠️, never guessed.
- **Test data:** scenarios really change data on the environment and nothing resets it between runs, so a
  scenario like "sign up with this address" works once. Describe reusable test data in `agent_notes`.
- **Evidence when the app needs a login:** no Playwright trace is saved, because it would record the typed
  credentials. Video and screenshots still are.
- **Experience so far:** a demo app and a real Jira Cloud site. Expect rough edges on a real application —
  [open an issue](https://github.com/mbukowski-dev/exhibit/issues) and you get hands-on help.

## Security and responsible use

The agent really clicks and submits forms: **run Exhibit only against preview or staging environments
with test data.** It never sends credentials to the model, never leaves your app's origin, and you pin the
action to a commit SHA so you only run code you chose. Details, what is sent to your model provider, and
how to report a vulnerability: **[SECURITY.md](SECURITY.md)**.

## Status

Early preview. What works and what's next: [ROADMAP.md](ROADMAP.md) · Changes: [CHANGELOG.md](CHANGELOG.md).

## License and pricing

Exhibit is **source-available** under the [Business Source License 1.1](LICENSE): the code is public so you
can read, audit and modify everything that runs with your secrets.

| | |
|---|---|
| **Free** | personal, non-commercial and educational use · repositories of open source projects · **one private repository per organization** (up to 10 contributors) · evaluation and testing, always |
| **Commercial license** | an organization using Exhibit on more than one private repository, or on a private repository with more than 10 contributors — [open an issue](https://github.com/mbukowski-dev/exhibit/issues/new?title=Commercial+license) titled "Commercial license"; no details are needed in public, we move to a private channel from there |

Each version becomes open source under Apache 2.0 four years after it is published. The license text is
what counts; this table is a summary.
