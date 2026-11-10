# Exhibit

Verifies that a pull request does what its ticket promised: reads the ticket (Jira or a Markdown file),
extracts acceptance criteria, drives the preview app in a real browser and posts a verdict with evidence.

## Layout
- `packages/core/src`: the pipeline. `jira.ts` (Jira Cloud REST v3, ADF → text), `acceptance.ts`
  (criteria from a field, an "Acceptance Criteria" section, Gherkin, or inferred by the model),
  `reconcile.ts` (criteria changed in ticket comments), `review.ts` → `plan.ts` → `browser/` →
  `verdict.ts` → `report-md.ts`, orchestrated by `run.ts`.
- `packages/cli/src/index.ts`: the `exhibit` CLI (`context`, `plan`, `verify`, `ci`).
- `action.yml` + `.github/workflows/selftest.yml`: the GitHub Action; the self-test runs it on every PR
  against `examples/demo-app` (deliberate AC3 bug, so "fail" is the expected verdict).
- `examples/PROJ-123.md`: the demo ticket. `.exhibit.yml`: example config, also drives the self-test.

## Commands (repo root)
- CLI without a build: `node_modules/.bin/tsx --conditions=development packages/cli/src/index.ts <cmd>`
  e.g. `context -t PROJ-1 --no-llm`, or `--ticket-file examples/PROJ-123.md`.
- Tests: `node_modules/.bin/vitest run`. Typecheck: `node_modules/.bin/tsc --noEmit -p packages/core`
  and `-p packages/cli`.
- Local secrets live in `.env` (gitignored, loaded by the CLI): `JIRA_*`, `OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`. Never print or commit them.

## Rules
- **This repository is public.** Commits, PR text, issues and CI logs must not contain private Jira
  URLs, e-mails, real ticket contents or customer data. Test data uses `example.com` / `acme.test`.
- Model calls cost money: check with `--no-llm` first and say the expected cost before a run with a model.
- Every parsing fix gets a unit test that fails before the fix. Prompts stay in English and tell the
  model to answer in the ticket's language; Polish keywords in `acceptance.ts` are intentional.
- User-visible changes get a line under "Unreleased" in `CHANGELOG.md`.
- License is BUSL-1.1: don't copy code in from projects with incompatible licenses.
