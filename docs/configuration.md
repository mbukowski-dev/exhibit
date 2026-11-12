# Configuration

Exhibit works without a configuration file: every setting has a default. To change one, add `.exhibit.yml`
to the root of the repository you verify and set only what you need. A typo or a wrong value stops the run
with a message that names the setting.

A test in this repository fails when a setting is missing from this page, so the list is complete.

## A typical file

```yaml
preview_url: "https://pr-{pr}.myapp.vercel.app"
language: pl                        # write the report in Polish, whatever language the ticket is in
agent_notes: |
  Registered test account: ana@example.com
  Never submit the payment form.
auth:
  - role: user
    username_env: EXHIBIT_USERNAME
    password_env: EXHIBIT_PASSWORD
```

## Tickets

| Setting | Default | What it does |
|---|---|---|
| `tracker` | `jira` | Where tickets come from. Jira Cloud is the only tracker so far; a Markdown file works through the action's `ticket-file` input. |
| `ticket_pattern` | `[A-Z][A-Z0-9]+-\d+` | Regular expression that finds the ticket key in the pull request title, branch name or description. Change it if your keys look different, e.g. `#\d+`. |
| `acceptance_headings` | `[]` | Extra headings that start the acceptance criteria section of a ticket. "Acceptance Criteria", "Acceptance", "Definition of Done", "AC" and "Kryteria akceptacji" are built in; add your own, e.g. `["Akzeptanzkriterien"]`. Without a known heading the model still picks the criteria out of the text, and the report says they were inferred. |

## Language

| Setting | Default | What it does |
|---|---|---|
| `language` | `auto` | The language of the review, the scenarios and the findings. `auto` follows each ticket. A code or a name (`pl`, `Polish`, `de`, `Deutsch`, `español`) fixes it for every report, whatever language the ticket is in. Text quoted from your app or the ticket is never translated. |

The fixed words of the report ("Acceptance criterion", "Evidence", "Needs human review") are in English, or
in Polish with `language: pl`. Other languages use the English words for now; everything the model writes is in
your language. The "what would unblock this" suggestions and the status line next to the checks are English.

## The app under test

| Setting | Default | What it does |
|---|---|---|
| `preview_url` | none | Address of the running app. `{pr}`, `{branch}` and `{sha}` are filled in from the pull request. The action's `preview-url` input overrides it. |
| `auth` | `[]` | Test accounts, one entry per role the scenarios may need. See below. |
| `allowed_origins` | `[]` | Other sites the browser may open, e.g. an SSO login page (`["https://login.example.com"]`). Every other navigation outside the app is blocked. |
| `agent_notes` | none | Facts about your test environment that are not in the ticket: test accounts, seed data, feature flags, what must not be touched. The review, the planner and the browser agent all read them. Never put passwords here. |

### `auth`

| Key | What it does |
|---|---|
| `role` | Name of the role, e.g. `user` or `admin`. Scenarios that need a signed-in user are run with it. |
| `username_env` | Name of the environment variable that holds the user name. The value comes from a GitHub secret passed to the action under `env:`. |
| `password_env` | The same for the password. |
| `login_flow` | Optional path to your own login script, e.g. `./e2e/login.ts`. Its default export is `async (page, { username, password }) => { … }` using Playwright's `page`. More reliable than letting the agent sign in, and needed for SSO or two-step logins. |

Credentials are typed into the browser by Exhibit and never sent to the model.

## Limits

| Setting | Default | What it does |
|---|---|---|
| `mode` | `comment` | `comment`: advisory, the status is never red. `check`: the status fails when an acceptance criterion is not met, so branch protection can block the merge. Start with `comment`. |
| `max_scenarios` | `8` | Most browser scenarios per run (1–20). Scenarios for the criteria come first; what did not fit is listed in the report. |
| `scenario_timeout_s` | `600` | Seconds one browser scenario may take before it is stopped and reported as blocked. |

## Generated tests

Settings under `tests`.

| Setting | Default | What it does |
|---|---|---|
| `dir` | `tests/exhibit` | Folder where a `/accept-tests` comment commits the generated Playwright file. A plain path inside the repository; it cannot contain `..` or point into `.github`. For this command the file is read from the default branch. |

```yaml
tests:
  dir: e2e/exhibit
```

Accepting tests with a comment is off until you add its workflow:
[github-action.md](github-action.md#accept-generated-tests-with-a-comment).

## Model

Settings under `model`.

| Setting | Default | What it does |
|---|---|---|
| `provider` | `anthropic` | `anthropic` or `openai`. If only the other provider's key is set, Exhibit switches by itself. |
| `name` | `claude-opus-5-5` / `gpt-5` | The model to use. |
| `max_cost_per_run_usd` | `1.5` | Hard cap for one run. When it is reached, the remaining scenarios are not run and the report says so. |
| `call_timeout_s` | `180` | Seconds to wait for one answer from the model before giving up on that call. |
| `price_per_mtok` | built-in list | `[input, output]` in USD per million tokens, for a model Exhibit has no price for. Without it the cost cap uses a deliberately high estimate. |
| `effort` | `review: medium`, `plan: low`, `agent: low`, `infer: low` | How hard the model thinks at each stage: `low`, `medium` or `high`. Higher is slower and costs more. `review` reads the diff, `plan` writes scenarios, `agent` drives the browser, `infer` finds criteria in tickets without a criteria section. |

```yaml
model:
  provider: openai
  name: gpt-5
  max_cost_per_run_usd: 3
  effort:
    review: high
```

## Inputs of the GitHub Action

Set under `with:` in the workflow. Keys always come from secrets.

| Input | Default | What it does |
|---|---|---|
| `preview-url` | `preview_url` from the file | Address of the pull request's deployment. |
| `openai-api-key` / `anthropic-api-key` | none | Your model key. Set one. |
| `model-provider`, `model` | from the file | Override `model.provider` and `model.name`. |
| `jira-base-url`, `jira-email`, `jira-api-token` | none | Jira Cloud access. Use a read-only account that sees only the projects to verify. |
| `ticket-file` | none | Read the ticket from a Markdown file in the repository instead of Jira. |
| `mode` | from the file | Override `mode`. |
| `preview-timeout` | `600` | Seconds to wait for the preview deployment to answer. |
| `debug` | `false` | Also save every full model prompt with the evidence. |
| `github-token` | the workflow's token | Used to read the pull request and to write the comment and the status. |

The action's `verdict` output is `pass`, `fail`, `needs_review` or `skipped`.
