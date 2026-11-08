# Exhibit in GitHub Actions

Add `.github/workflows/exhibit.yml` to the repository you want to verify:

```yaml
name: Exhibit
on: pull_request

permissions:
  contents: read
  pull-requests: write   # the report comment
  statuses: write        # the "Exhibit" status next to the checks

jobs:
  exhibit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1 — .exhibit.yml and login scripts live in your repo
      - uses: Lulek77777/exhibit@a4140f7beb9427548c1457c326264774cb2c4e36  # v0.3.0 — always pin a full SHA, see SECURITY.md
        with:
          preview-url: https://myapp-git-{branch}-acme.vercel.app
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          jira-base-url: https://acme.atlassian.net
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
        env:                                 # only if the app needs a login (see auth in .exhibit.yml)
          EXHIBIT_USERNAME: ${{ secrets.E2E_USERNAME }}
          EXHIBIT_PASSWORD: ${{ secrets.E2E_PASSWORD }}
```

What happens on every push to the PR:

1. The "Exhibit" status turns **pending**.
2. Exhibit waits for the preview deployment (up to `preview-timeout`, 10 minutes by default).
3. It reads the ticket (key from the PR title or branch), reviews the diff, plans scenarios and runs them in Chromium.
4. One PR comment is created — and **edited in place** on later pushes — with ✅ / ❌ / ⚠️ per acceptance criterion,
   the code review, every scenario and the generated Playwright tests.
5. Videos, traces and screenshots are uploaded as the `exhibit-evidence-pr<N>` artifact of the workflow run.
6. The status becomes **success**; in `mode: check` it becomes **failure** when an acceptance criterion is not met,
   which can block merging via branch protection.

Notes

- Pull requests from forks do not get repository secrets, so Exhibit cannot run on them.
- Run it only against preview/staging environments with test data and test accounts — the agent really
  clicks and submits. See [SECURITY.md](../SECURITY.md).
- Costs are billed to your own model API key. The per-run cap is `model.max_cost_per_run_usd` in `.exhibit.yml`.
