import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { chromium } from "playwright";
import { replayScenario, runScenarios, type ScenarioResult } from "./browser/agent.js";
import { resolveRoleAuth, type RoleAuth } from "./browser/auth.js";
import { generateTests, type GeneratedTests } from "./codegen.js";
import { blockedHint } from "./hints.js";
import type { AcceptanceCriterion } from "./acceptance.js";
import type { ExhibitConfig } from "./config.js";
import type { VerificationContext } from "./context.js";
import { planVerification, type VerificationPlan } from "./plan.js";
import { reviewChanges, type Review } from "./review.js";
import type { RunLog } from "./runlog.js";
import type { UsageMeter } from "./usage.js";
import { judge, type RunVerdict } from "./verdict.js";

export interface RunReport {
  ticket: { key: string; summary: string; url: string };
  /** The criteria as verified — after changes from ticket comments. */
  criteria: AcceptanceCriterion[];
  baseUrl: string;
  verdict: RunVerdict;
  review: Review;
  plan: VerificationPlan;
  results: ScenarioResult[];
  generatedTests?: GeneratedTests;
  usage: { model: string; costUsd: number; priceKnown: boolean; inputTokens: number; outputTokens: number };
  warnings: string[];
  runDir: string;
  durationMs: number;
  /** Path of summary.md when a RunLog was given. */
  diagnostics?: string;
}

export interface RunVerificationOptions {
  config: ExhibitConfig;
  ctx: VerificationContext;
  model: LanguageModel;
  meter: UsageMeter;
  baseUrl: string;
  /** Repository checkout, for login_flow scripts. */
  repoDir: string;
  artifactsRoot: string;
  maxSteps?: number;
  headless?: boolean;
  onProgress?: (message: string) => void;
  onScenario?: (r: ScenarioResult) => void;
  /** Diagnostics; pass the same RunLog whose wrap() produced `model`. */
  log?: RunLog;
}

/** The whole pipeline: review → plan → browser agent → replay → judge → codegen. */
export async function runVerification(o: RunVerificationOptions): Promise<RunReport> {
  const started = Date.now();
  const progress = o.onProgress ?? (() => {});
  const rl = o.log;
  const stage = (label: string, message: string) => {
    rl?.setLabel(label);
    rl?.log({ type: "stage", stage: message });
    if (!rl?.opts.echo) progress(message);
  };
  const { ctx } = o;

  const runDir = join(o.artifactsRoot, `${ctx.ticket.key}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(runDir, { recursive: true });
  rl?.attach(runDir);
  for (const w of ctx.warnings) rl?.log({ type: "warning", message: w });

  stage("review", `Reviewing ${ctx.changes.files.length} files against ${ctx.criteria.length} criteria…`);
  const review = await reviewChanges(ctx, o.model, o.meter, o.config.model.effort);
  stage("plan", "Planning scenarios…");
  const plan = await planVerification(ctx, review, o.model, { maxScenarios: o.config.max_scenarios, meter: o.meter, effort: o.config.model.effort });

  const roles = [...new Set(plan.scenarios.map((s) => s.role))];
  const auth = new Map<string, RoleAuth>();
  for (const r of roles) auth.set(r, await resolveRoleAuth(o.config, r, o.repoDir));

  stage("agent", `Running ${plan.scenarios.length} scenarios in the browser…`);
  const results: ScenarioResult[] = [];
  for (const role of roles) {
    const a = auth.get(role)!;
    results.push(
      ...(await runScenarios(
        plan.scenarios.filter((s) => s.role === role),
        { baseUrl: o.baseUrl, model: o.model, meter: o.meter, artifactsDir: runDir, secrets: a.secrets, login: a.login, maxSteps: o.maxSteps, headless: o.headless, log: rl, effort: o.config.model.effort, notes: o.config.agent_notes, allowedOrigins: o.config.allowed_origins },
        o.onScenario,
      )),
    );
  }

  const passed = results.filter((r) => r.verdict === "pass");
  if (passed.length) {
    stage("replay", `Replaying ${passed.length} passed scenario(s) without AI…`);
    const browser = await chromium.launch({ headless: o.headless ?? true });
    try {
      for (const r of passed) {
        const s = plan.scenarios.find((x) => x.id === r.scenarioId)!;
        const a = auth.get(s.role)!;
        r.replay = await replayScenario(r, s, { baseUrl: o.baseUrl, secrets: a.secrets, login: a.login, browser, allowedOrigins: o.config.allowed_origins });
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  for (const r of results) {
    rl?.log({ type: "scenario_end", scenarioId: r.scenarioId, title: r.title, verdict: r.verdict, reason: r.reason, steps: r.steps.length, durationMs: r.durationMs, replay: r.replay });
  }
  // E13-2: every blocked scenario gets a suggestion for what would unblock it, where there is one.
  for (const r of results) {
    const hint = blockedHint(r, plan.scenarios.find((s) => s.id === r.scenarioId), o.config);
    if (hint) r.hint = hint;
  }
  const verdict = judge(ctx.criteria, review, results);
  const generatedTests = generateTests(ctx.ticket.key, plan.scenarios, results);
  if (generatedTests) await writeFile(join(runDir, generatedTests.fileName), generatedTests.content);

  const report: RunReport = {
    ticket: { key: ctx.ticket.key, summary: ctx.ticket.summary, url: ctx.ticket.url },
    criteria: ctx.criteria,
    baseUrl: o.baseUrl,
    verdict,
    review,
    plan,
    results,
    generatedTests,
    usage: { model: o.meter.modelName, costUsd: o.meter.costUsd, priceKnown: o.meter.priceKnown, inputTokens: o.meter.inputTokens, outputTokens: o.meter.outputTokens },
    warnings: ctx.warnings,
    runDir,
    durationMs: Date.now() - started,
  };
  if (rl) {
    rl.summary(o.meter.modelName);
    report.diagnostics = join(runDir, "summary.md");
  }
  await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
