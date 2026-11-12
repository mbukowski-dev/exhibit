#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { Command } from "commander";
import { createRequire } from "node:module";

// Single source of truth for the version: packages/cli/package.json (works from src/ and dist/).
const CLI_VERSION: string = createRequire(import.meta.url)("../package.json").version;
import {
  acceptTests,
  buildContext,
  createMeter,
  createModel,
  detectTicketKey,
  fetchJiraTicket,
  githubChangeSet,
  hasModelKey,
  modelName,
  resolveModelConfig,
  isIgnoredPath,
  jiraCredentialsFromEnv,
  loadConfig,
  localChangeSet,
  parsePrRef,
  planVerification,
  COMMENT_MARKER,
  expandPreviewUrl,
  pullRequestFromEvent,
  renderMarkdownReport,
  reviewChanges,
  runVerification,
  setCommitStatus,
  skipReason,
  statusFor,
  NoTicketKeyError,
  ticketFromFile,
  upsertPrComment,
  RunLog,
  waitForUrl,
  type RunReport,
  type ScenarioResult,
  type Skip,
  type ExhibitConfig,
  type Review,
  type UsageMeter,
  type VerificationContext,
  type VerificationPlan,
} from "@exhibit/core";

// Load .env from the current directory if present (Node >= 21.7).
try {
  process.loadEnvFile?.();
} catch {
  /* no .env — fine */
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface ModelOptions {
  provider?: "anthropic" | "openai";
  model?: string;
}

interface SourceOptions extends ModelOptions {
  ticket?: string;
  ticketFile?: string;
  pr?: string;
  base: string;
  cwd: string;
  json?: boolean;
  llm: boolean;
}

function withModelOptions(cmd: Command): Command {
  return cmd
    .option("--provider <name>", "model provider: anthropic | openai (default: .exhibit.yml, or whichever key is set)")
    .option("--model <name>", "model id, e.g. claude-opus-5-5 or gpt-5 (default: .exhibit.yml or the provider default)");
}

function withSourceOptions(cmd: Command): Command {
  return withModelOptions(cmd)
    .option("-t, --ticket <key>", "ticket key, e.g. PROJ-123 (default: detected from PR title / branch)")
    .option("--ticket-file <path>", "read the ticket from a Markdown file instead of Jira")
    .option("--pr <ref>", "GitHub PR: owner/repo#123 or URL (default: local git diff)")
    .option("-b, --base <branch>", "base branch for local diff", "main")
    .option("-C, --cwd <dir>", "repository directory", process.cwd())
    .option("--json", "print machine-readable JSON");
}

/** .exhibit.yml + model overrides; switches provider when only the other key is set. */
async function loadExhibitConfig(cwd: string, o: ModelOptions, quiet = false): Promise<ExhibitConfig> {
  if (o.provider && o.provider !== "anthropic" && o.provider !== "openai") {
    throw new Error(`--provider must be anthropic or openai (got "${o.provider}")`);
  }
  const config = await loadConfig(cwd);
  const r = resolveModelConfig(config.model, { provider: o.provider, name: o.model });
  if (r.note && !quiet) console.error(dim(r.note));
  return { ...config, model: r.model };
}

async function loadContext(opts: SourceOptions, config: ExhibitConfig, meter?: UsageMeter) {
  const changes = opts.pr
    ? await githubChangeSet(parsePrRef(opts.pr), process.env.GITHUB_TOKEN)
    : await localChangeSet(opts.cwd, opts.base);

  const fetchTicket = opts.ticketFile
    ? (key: string) => ticketFromFile(opts.ticketFile!, key)
    : (key: string) => fetchJiraTicket(key, jiraCredentialsFromEnv());

  const model = opts.llm && hasModelKey(config.model) ? createModel(config.model) : undefined;

  return buildContext({
    config,
    changes,
    ticketKey: opts.ticket,
    fallbackTicketKey: opts.ticketFile ? basename(opts.ticketFile).replace(/\.[^.]+$/, "") : undefined,
    fetchTicket,
    model,
    meter,
  });
}

const program = new Command()
  .name("exhibit")
  .description("Verify that a change does what its ticket promised.")
  .version(CLI_VERSION);

withSourceOptions(program.command("context"))
  .description("Show the ticket, acceptance criteria and diff Exhibit would verify")
  .option("--no-llm", "never call the model (no AC inference)")
  .action(async (opts: SourceOptions) => {
    const config = await loadExhibitConfig(opts.cwd, opts, opts.json);
    const ctx = await loadContext(opts, config);
    if (opts.json) console.log(JSON.stringify(ctx, null, 2));
    else printContext(ctx);
  });

withSourceOptions(program.command("plan"))
  .description("Review the change against the acceptance criteria and plan browser scenarios")
  .action(async (opts: SourceOptions) => {
    const config = await loadExhibitConfig(opts.cwd, opts, opts.json);
    const { model, meter } = requireModel(config, "exhibit plan");

    const ctx = await loadContext({ ...opts, llm: true }, config, meter);
    if (!ctx.criteria.length) {
      printContext(ctx);
      throw new Error(`${ctx.ticket.key} has no acceptance criteria, so there is nothing to verify.`);
    }
    if (!opts.json) console.error(dim(`Reviewing ${ctx.changes.files.length} files against ${ctx.criteria.length} criteria…`));
    const review = await reviewChanges(ctx, model, meter);
    if (!opts.json) console.error(dim("Planning scenarios…"));
    const plan = await planVerification(ctx, review, model, { maxScenarios: config.max_scenarios, meter });

    if (opts.json) {
      console.log(JSON.stringify({ ticket: ctx.ticket.key, criteria: ctx.criteria, review, plan, usage: { ...meter, costUsd: meter.costUsd }, warnings: ctx.warnings }, null, 2));
      return;
    }
    printContext(ctx, { compact: true });
    printReview(ctx, review);
    printPlan(plan);
    console.log(dim(`\n${meter.summary()}\n`));
  });

function requireModel(config: ExhibitConfig, command: string) {
  if (!hasModelKey(config.model)) {
    throw new Error(`"${command}" needs a model key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY (in .env locally, or as a GitHub secret).`);
  }
  console.error(dim(`Model: ${modelName(config.model)} (${config.model.provider})`));
  return { model: createModel(config.model), meter: createMeter(config.model) };
}

const scenarioLine = (r: ScenarioResult) =>
  `  ${VERDICT_ICON[r.verdict]} ${r.scenarioId} ${r.title} (${r.steps.length} steps, ${Math.round(r.durationMs / 1000)}s)`;

withSourceOptions(program.command("verify"))
  .description("Review, plan and run the scenarios in a browser against a running app")
  .option("-u, --url <url>", "base URL of the app under test (default: preview_url from .exhibit.yml)")
  .option("--headed", "show the browser window")
  .option("--max-steps <n>", "max agent steps per scenario", (v) => parseInt(v, 10), 20)
  .option("-o, --out <dir>", "artifacts directory", "exhibit-artifacts")
  .option("-v, --verbose", "print every agent step and its reasoning")
  .option("--debug", "also save every full model prompt to the artifacts (prompts/)")
  .action(async (opts: SourceOptions & { url?: string; headed?: boolean; maxSteps: number; out: string; verbose?: boolean; debug?: boolean }) => {
    const config = await loadExhibitConfig(opts.cwd, opts);
    const baseUrl = opts.url ?? config.preview_url;
    if (!baseUrl) throw new Error("No app URL. Pass --url http://localhost:3000 or set preview_url in .exhibit.yml.");
    if (/\{(pr|branch|sha)\}/.test(baseUrl)) throw new Error(`preview_url "${baseUrl}" has placeholders; pass --url for local runs.`);
    const log = (s: string) => !opts.json && console.error(dim(s));
    const runLog = new RunLog({ debug: opts.debug, echo: opts.verbose && !opts.json ? log : undefined });
    const required = requireModel(config, "exhibit verify");
    const model = runLog.wrap(required.model);
    const meter = required.meter;

    log(`Waiting for ${baseUrl}…`);
    await waitForUrl(baseUrl, { timeoutMs: 60_000 });
    const ctx = await loadContext({ ...opts, llm: true }, config, meter);
    if (!ctx.criteria.length) throw new Error(`${ctx.ticket.key} has no acceptance criteria, so there is nothing to verify.`);

    const report = await runVerification({
      config, ctx, model, meter, baseUrl,
      repoDir: opts.cwd,
      artifactsRoot: resolve(opts.out),
      maxSteps: opts.maxSteps,
      headless: !opts.headed,
      onProgress: log,
      onScenario: (r) => log(scenarioLine(r)),
      log: runLog,
    });

    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printVerdict(ctx, report, meter.summary());
    process.exitCode = report.verdict.overall === "fail" ? 1 : 0;
  });

withModelOptions(program.command("ci"))
  .description("Run inside GitHub Actions on a pull_request: verify the preview and report in the PR")
  .option("-u, --url <url>", "preview URL; {pr}, {branch} and {sha} are expanded (default: preview_url from .exhibit.yml)")
  .option("-C, --cwd <dir>", "repository checkout", process.cwd())
  .option("-o, --out <dir>", "artifacts directory", "exhibit-artifacts")
  .option("--mode <mode>", "comment | check (default: mode from .exhibit.yml)")
  .option("--ticket-file <path>", "read the ticket from a Markdown file instead of Jira")
  .option("--preview-timeout <s>", "seconds to wait for the preview deploy", (v) => parseInt(v, 10), 600)
  .option("--debug", "also save every full model prompt to the artifacts (prompts/)")
  .action(async (opts: ModelOptions & { url?: string; cwd: string; out: string; mode?: "comment" | "check"; ticketFile?: string; previewTimeout: number; debug?: boolean }) => {
    const env = process.env;
    if (!env.GITHUB_EVENT_PATH) throw new Error('"exhibit ci" runs inside GitHub Actions. Use "exhibit verify" locally.');
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set (pass github-token to the action).");
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));

    // A comment on a pull request: the only thing Exhibit does with one is /accept-tests.
    // No model, no browser, and it is decided before anything else can run.
    if (env.GITHUB_EVENT_NAME === "issue_comment" || (event.comment && event.issue)) {
      const [owner, repo] = (env.GITHUB_REPOSITORY ?? event.repository?.full_name ?? "").split("/");
      if (!owner || !repo) throw new Error("Cannot tell the repository (GITHUB_REPOSITORY is not set).");
      const result = await acceptTests({ owner, repo, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL }, event, await loadConfig(opts.cwd));
      console.log(result.message);
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `verdict=skipped\naccept-tests=${result.outcome}\n`);
      return;
    }

    const pr = pullRequestFromEvent(event, env.GITHUB_REPOSITORY);
    const gh = { owner: pr.owner, repo: pr.repo, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL };
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${pr.owner}/${pr.repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

    const config = await loadExhibitConfig(opts.cwd, opts);
    const mode = opts.mode ?? config.mode;
    const template = opts.url ?? config.preview_url;
    if (!template) throw new Error("No preview URL. Set preview_url in .exhibit.yml or the preview-url input.");

    // Pull requests Exhibit cannot or need not verify end quietly: a notice and, where the token
    // allows it, a green "Skipped" status — not a failed job on every fork or Dependabot bump.
    const skip = async (s: Skip) => {
      console.log(`::notice title=Exhibit skipped::${s.notice}`);
      await setCommitStatus(gh, pr.headSha, "success", s.status, runUrl).catch(() => {}); // read-only token on forks
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "verdict=skipped\n");
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Exhibit\n⏭️ ${s.notice}\n`);
    };
    const skipped = skipReason({
      event,
      actor: env.GITHUB_ACTOR,
      hasModelKey: hasModelKey(config.model),
      hasTicket: Boolean(opts.ticketFile) || Boolean(detectTicketKey({ prTitle: pr.title, branch: pr.branch, prBody: pr.body }, config.ticket_pattern)),
    });
    if (skipped) return skip(skipped);

    const baseUrl = expandPreviewUrl(template, { pr: pr.number, branch: pr.branch, sha: pr.headSha });
    const runLog = new RunLog({ debug: opts.debug, echo: (l) => console.log(l) });
    const required = requireModel(config, "exhibit ci");
    const model = runLog.wrap(required.model);
    const meter = required.meter;

    await setCommitStatus(gh, pr.headSha, "pending", "Verifying acceptance criteria…", runUrl);
    try {
      console.log(`Waiting for preview ${baseUrl}…`);
      await waitForUrl(baseUrl, { timeoutMs: opts.previewTimeout * 1000 });

      const changes = await githubChangeSet({ owner: pr.owner, repo: pr.repo, number: pr.number }, env.GITHUB_TOKEN);
      const fetchTicket = opts.ticketFile
        ? (key: string) => ticketFromFile(opts.ticketFile!, key)
        : (key: string) => fetchJiraTicket(key, jiraCredentialsFromEnv());
      runLog.setLabel("infer-ac");
      const ctx = await buildContext({
        config, changes, fetchTicket, model, meter,
        fallbackTicketKey: opts.ticketFile ? basename(opts.ticketFile).replace(/\.[^.]+$/, "") : undefined,
      });

      if (!ctx.criteria.length) {
        const body = `${COMMENT_MARKER}\n### Exhibit · ${ctx.ticket.key}\n⚠️ The ticket has no acceptance criteria, so there is nothing to verify. Add an "Acceptance Criteria" list to the ticket and push again.`;
        await upsertPrComment(gh, pr.number, body);
        await setCommitStatus(gh, pr.headSha, "success", "No acceptance criteria on the ticket", runUrl);
        return;
      }

      const report = await runVerification({
        config, ctx, model, meter, baseUrl,
        repoDir: opts.cwd,
        artifactsRoot: resolve(opts.out),
        onProgress: (s) => console.log(s),
        onScenario: (r) => console.log(scenarioLine(r)),
        log: runLog,
      });

      const url = await upsertPrComment(gh, pr.number, renderMarkdownReport(report, { artifactsUrl: runUrl }));
      const status = statusFor(report.verdict, mode);
      await setCommitStatus(gh, pr.headSha, status.state, status.description, url);
      console.log(`${status.description}\nReport: ${url}\n${meter.summary()}`);
      if (env.GITHUB_OUTPUT) {
        await appendFile(env.GITHUB_OUTPUT, `verdict=${report.verdict.overall}\nreport-dir=${report.runDir}\n`);
      }
      if (env.GITHUB_STEP_SUMMARY) {
        await appendFile(env.GITHUB_STEP_SUMMARY, renderMarkdownReport(report, { artifactsUrl: runUrl }) + "\n\n---\n\n" + runLog.summary(meter.modelName));
      }
    } catch (e) {
      if (e instanceof NoTicketKeyError) {
        // The event said there was a key, the fetched PR says there is none (e.g. the title was just edited).
        return skip(skipReason({ event, hasModelKey: true, hasTicket: false })!);
      }
      const msg = e instanceof Error ? e.message : String(e);
      await setCommitStatus(gh, pr.headSha, "error", `Exhibit could not run: ${msg}`, runUrl).catch(() => {});
      await upsertPrComment(gh, pr.number, `${COMMENT_MARKER}\n### Exhibit\n⛔ Could not run the verification: ${msg}${runUrl ? `\n\n[Workflow log](${runUrl})` : ""}`).catch(() => {});
      throw e;
    }
  });

function printContext(ctx: VerificationContext, { compact = false } = {}) {
  const { ticket, criteria, changes, warnings } = ctx;
  const files = changes.files.filter((f) => !isIgnoredPath(f.path));

  console.log(bold(`\n${ticket.key}  ${ticket.summary}`));
  if (ticket.url) console.log(dim(`${ticket.url}  ·  ${ticket.type}  ·  ${ticket.status}`));

  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const changeLine = `Changes (${changes.source}: ${changes.branch ?? changes.head})  ${files.length} files  +${adds} −${dels}`;

  if (compact) {
    console.log(dim(changeLine));
  } else {
    console.log(bold(`\nAcceptance criteria (${criteria.length})`));
    for (const ac of criteria) {
      console.log(`  ${ac.id}  ${ac.text}  ${dim(`[${ac.source}]`)}`);
      if (ac.changedBy) {
        const was = ac.changedBy.previousText ? ` (was: ${ac.changedBy.previousText})` : "";
        console.log(dim(`       ✏️  changed in a comment by ${ac.changedBy.author}, ${ac.changedBy.created.slice(0, 10)}${was}`));
      }
    }
    if (!criteria.length) console.log(dim("  (none)"));
    if (ticket.comments.length) console.log(dim(`\n${ticket.comments.length} comment(s) on the ticket`));
    console.log(bold(`\n${changeLine}`));
    for (const f of files.slice(0, 40)) {
      console.log(`  ${f.status.padEnd(8)} ${f.path}  ${dim(`+${f.additions} −${f.deletions}`)}`);
    }
    if (files.length > 40) console.log(dim(`  … and ${files.length - 40} more`));
  }

  if (warnings.length) {
    console.log(bold("\nWarnings"));
    for (const w of warnings) console.log(`  ⚠️  ${w}`);
  }
  if (!compact) console.log();
}

const VERDICT_ICON = { pass: "✅", partial: "🟡", fail: "❌", blocked: "⛔", unverified: "⚠️" } as const;
const OVERALL = { pass: "✅ All acceptance criteria verified", fail: "❌ Acceptance criteria not met", needs_review: "⚠️ Needs human review" } as const;

function printVerdict(ctx: VerificationContext, report: RunReport, cost: string) {
  const v = report.verdict;
  const passed = v.criteria.filter((c) => c.verdict === "pass").length;
  console.log(bold(`\n${ctx.ticket.key}  ${ctx.ticket.summary}   ${passed}/${v.criteria.length}`));
  console.log(bold(OVERALL[v.overall]) + "\n");
  for (const c of v.criteria) {
    console.log(`${VERDICT_ICON[c.verdict]} ${bold(c.acId)} ${c.text}`);
    console.log(`     ${c.summary}`);
  }
  const problems = report.results.filter((r) => r.consoleErrors.length || r.failedRequests.length);
  if (problems.length) {
    console.log(bold("\nErrors seen in the browser"));
    for (const r of problems) {
      for (const e of [...r.failedRequests, ...r.consoleErrors].slice(0, 5)) console.log(dim(`  ${r.scenarioId}: ${e}`));
    }
  }
  const hints = new Map<string, { ids: string[]; snippet?: string }>();
  for (const r of report.results) {
    if (r.verdict !== "blocked" || !r.hint) continue;
    const g = hints.get(r.hint.text) ?? { ids: [], snippet: r.hint.snippet };
    g.ids.push(r.scenarioId);
    hints.set(r.hint.text, g);
  }
  if (hints.size) {
    console.log(bold("\nTo get the blocked scenarios checked"));
    for (const [text, g] of hints) {
      console.log(`  ${g.ids.join(", ")}: ${text}`);
      if (g.snippet) console.log(dim(g.snippet.replace(/^/gm, "      ")));
    }
  }
  const rel = relative(process.cwd(), report.runDir) || report.runDir;
  if (report.generatedTests) {
    console.log(bold(`\n🧪 ${report.generatedTests.scenarioIds.length} Playwright test(s) generated: ${rel}/${report.generatedTests.fileName}`));
  }
  const firstTrace = report.results.find((r) => r.artifacts.trace)?.artifacts.trace;
  console.log(dim(`\nEvidence (video, trace, screenshots): ${rel}`));
  if (report.diagnostics) console.log(dim(`Run diagnostics: ${relative(process.cwd(), report.diagnostics)}`));
  if (firstTrace) console.log(dim(`Replay a trace: npx playwright show-trace ${relative(process.cwd(), firstTrace)}`));
  console.log(dim(`${cost}\n`));
}

const ICON = { covered: "✅", partial: "🟡", missing: "❌", unclear: "❔" } as const;

function printReview(ctx: VerificationContext, review: Review) {
  console.log(bold("\nCode vs acceptance criteria"));
  for (const c of review.coverage) {
    const ac = ctx.criteria.find((a) => a.id === c.acId);
    console.log(`  ${ICON[c.status]} ${c.acId}  ${ac?.text ?? ""}`);
    console.log(`       ${c.explanation}`);
    for (const e of c.evidence.slice(0, 3)) console.log(dim(`       ${e.file}: ${e.note}`));
  }
  if (review.risks.length) {
    console.log(bold("\nRisk"));
    for (const r of review.risks) {
      console.log(`  ${r.severity.toUpperCase().padEnd(6)} ${r.area} — ${r.reason}`);
    }
  }
}

function printPlan(plan: VerificationPlan) {
  console.log(bold(`\nVerification plan (${plan.scenarios.length} scenarios)`));
  for (const s of plan.scenarios) {
    const acs = s.acIds.length ? s.acIds.join(", ") : "regression";
    console.log(`\n  ${bold(`${s.id} [${s.priority}]`)} ${s.title}  ${dim(`${acs} · ${s.role} · ${s.startPath}`)}`);
    s.steps.forEach((step, i) => console.log(`     ${i + 1}. ${step}`));
    for (const e of s.expected) console.log(`     → ${e}`);
    if (s.notTestableInBrowser) console.log(dim(`     ⚠️  not testable in browser: ${s.notTestableInBrowser}`));
  }
  if (plan.skipped.length) {
    console.log(dim(`\n  Skipped by limit (max_scenarios): ${plan.skipped.map((s) => s.title).join("; ")}`));
  }
}

program.parseAsync().catch((e) => {
  console.error(`\x1b[31merror:\x1b[0m ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
