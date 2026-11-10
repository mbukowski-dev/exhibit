import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
import { PRICES } from "./usage.js";

/**
 * Run diagnostics for us (the Exhibit developers): every model call, every
 * browser action and every stage, as JSONL plus a readable summary.md.
 * This is what tells us where prompts fail, where money and time go, and
 * which runs to turn into eval cases.
 */
export type RunEvent =
  | { type: "stage"; stage: string }
  | { type: "llm_call"; label: string; durationMs: number; inputTokens: number; outputTokens: number; output: string; error?: string; promptFile?: string }
  | { type: "action"; scenarioId: string; n: number; action: string; target?: string; value?: string; thought?: string; ok: boolean; error?: string; url: string; dialogs?: string }
  | { type: "nudge"; scenarioId: string; n: number; kind: string; message: string }
  | { type: "scenario_end"; scenarioId: string; title: string; verdict: string; reason: string; steps: number; durationMs: number; replay?: string }
  | { type: "warning" | "error"; message: string };

type Stamped = RunEvent & { ts: string; tMs: number };

export class RunLog {
  private readonly events: Stamped[] = [];
  private readonly started = Date.now();
  private label = "setup";
  private promptCount = 0;
  private dir?: string;

  /**
   * @param debug also save every full prompt (what the model saw) to prompts/.
   * @param echo  mirror important events to the console (CI logs).
   */
  constructor(readonly opts: { debug?: boolean; echo?: (line: string) => void } = {}) {}

  /** Starts writing to `<dir>/events.jsonl`; earlier events are flushed. */
  attach(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : ""));
  }

  /** Names the following model calls, e.g. "review" or "S2:step3". */
  setLabel(label: string) {
    this.label = label;
  }

  log(e: RunEvent) {
    const stamped = { ...e, ts: new Date().toISOString(), tMs: Date.now() - this.started } as Stamped;
    this.events.push(stamped);
    if (this.dir) appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(stamped) + "\n");
    const echo = this.opts.echo;
    if (!echo) return;
    if (e.type === "stage") echo(`▸ ${e.stage}`);
    if (e.type === "action") echo(`    ${e.scenarioId}#${e.n} ${e.action}${e.target ? ` ${e.target}` : ""}${e.value ? ` = ${e.value}` : ""} → ${e.ok ? "ok" : `FAILED: ${e.error}`}${e.dialogs ? ` [${e.dialogs}]` : ""}${e.thought ? `   💭 ${e.thought}` : ""}`);
    if (e.type === "nudge") echo(`    🔔 ${e.scenarioId}#${e.n} ${e.kind}: ${e.message.split("\n")[0]}`);
    if (e.type === "llm_call" && e.error) echo(`    ⚠️ model call ${e.label} failed: ${e.error}`);
    if (e.type === "warning" || e.type === "error") echo(`${e.type === "error" ? "✖" : "⚠️"} ${e.message}`);
  }

  /** Wraps a model so every call is timed and recorded, whoever makes it. */
  wrap(model: LanguageModel): LanguageModel {
    if (typeof model === "string") return model; // gateway ids: nothing to wrap
    const middleware: LanguageModelMiddleware = {
      wrapGenerate: async ({ doGenerate, params }) => {
        const label = this.label;
        const t0 = Date.now();
        let promptFile: string | undefined;
        if (this.opts.debug && this.dir) {
          const dir = join(this.dir, "prompts");
          mkdirSync(dir, { recursive: true });
          promptFile = join("prompts", `${String(++this.promptCount).padStart(3, "0")}-${label.replace(/[^\w.-]+/g, "_")}.json`);
          writeFileSync(join(this.dir, promptFile), JSON.stringify(params.prompt, null, 2));
        }
        try {
          const result = await doGenerate();
          const output = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");
          this.log({
            type: "llm_call", label, durationMs: Date.now() - t0, promptFile,
            inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0,
            output: output.slice(0, 4000),
          });
          return result;
        } catch (e) {
          this.log({ type: "llm_call", label, durationMs: Date.now() - t0, inputTokens: 0, outputTokens: 0, output: "", error: (e as Error).message.slice(0, 500), promptFile });
          throw e;
        }
      },
    };
    return wrapLanguageModel({ model: model as WrappableModel, middleware });
  }

  get all(): readonly Stamped[] {
    return this.events;
  }

  /** Human-readable digest; also written to summary.md when attached. */
  summary(modelName: string): string {
    const calls = this.events.filter((e): e is Extract<Stamped, { type: "llm_call" }> => e.type === "llm_call");
    const actions = this.events.filter((e): e is Extract<Stamped, { type: "action" }> => e.type === "action");
    const scenarios = this.events.filter((e): e is Extract<Stamped, { type: "scenario_end" }> => e.type === "scenario_end");
    const nudges = this.events.filter((e): e is Extract<Stamped, { type: "nudge" }> => e.type === "nudge");
    const price = PRICES[modelName];
    const usd = (i: number, o: number) => (price ? `$${((i * price[0] + o * price[1]) / 1e6).toFixed(3)}` : "–");

    // Group calls by stage: "S2:step3" → "S2".
    const stages = new Map<string, { calls: number; ms: number; i: number; o: number; errors: number }>();
    for (const c of calls) {
      const k = c.label.split(":")[0]!;
      const s = stages.get(k) ?? { calls: 0, ms: 0, i: 0, o: 0, errors: 0 };
      s.calls++; s.ms += c.durationMs; s.i += c.inputTokens; s.o += c.outputTokens; if (c.error) s.errors++;
      stages.set(k, s);
    }
    const totalMs = Date.now() - this.started;
    const failed = actions.filter((a) => !a.ok);

    const lines = [
      `# Exhibit run diagnostics`,
      ``,
      `Total ${Math.round(totalMs / 1000)}s · ${calls.length} model calls · ${actions.length} browser actions (${failed.length} failed) · model ${modelName}`,
      ``,
      `## Where time and money went`,
      ``,
      `| Stage | Calls | Model time | Input tok | Output tok | Cost | Errors |`,
      `|---|---|---|---|---|---|---|`,
      ...[...stages].map(([k, s]) => `| ${k} | ${s.calls} | ${(s.ms / 1000).toFixed(1)}s | ${s.i} | ${s.o} | ${usd(s.i, s.o)} | ${s.errors} |`),
      ``,
      `## Scenarios`,
      ``,
      `| Scenario | Verdict | Steps | Failed actions | Nudges | Time | Replay |`,
      `|---|---|---|---|---|---|---|`,
      ...scenarios.map((s) => {
        const f = actions.filter((a) => a.scenarioId === s.scenarioId && !a.ok).length;
        const nd = nudges.filter((x) => x.scenarioId === s.scenarioId).length;
        return `| ${s.scenarioId} ${s.title.replace(/\|/g, "\\|")} | ${s.verdict} | ${s.steps} | ${f} | ${nd} | ${(s.durationMs / 1000).toFixed(1)}s | ${s.replay ?? "–"} |`;
      }),
    ];
    if (failed.length) {
      lines.push(``, `## Failed browser actions (prompt / selector problems)`, ``);
      for (const a of failed) lines.push(`- **${a.scenarioId}#${a.n}** \`${a.action} ${a.target ?? ""}\` — ${a.error}${a.thought ? ` _(model: ${a.thought})_` : ""}`);
    }
    if (nudges.length) {
      lines.push(``, `## Supervisor nudges (where the agent needed help)`, ``);
      for (const x of nudges) lines.push(`- **${x.scenarioId}#${x.n}** \`${x.kind}\` — ${x.message.split("\n")[0]}`);
    }
    const slow = [...calls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
    if (slow.length) {
      lines.push(``, `## Slowest model calls`, ``, ...slow.map((c) => `- ${c.label}: ${(c.durationMs / 1000).toFixed(1)}s, ${c.inputTokens} input tokens`));
    }
    const problems = this.events.filter((e) => e.type === "warning" || e.type === "error" || (e.type === "llm_call" && e.error));
    if (problems.length) {
      lines.push(``, `## Warnings and errors`, ``, ...problems.map((e) => `- ${"message" in e ? e.message : `${(e as any).label}: ${(e as any).error}`}`));
    }
    lines.push(``, `Raw events: \`events.jsonl\`${this.opts.debug ? " · full prompts: `prompts/`" : " · run with --debug to also save full prompts"}`);
    const md = lines.join("\n") + "\n";
    if (this.dir) writeFileSync(join(this.dir, "summary.md"), md);
    return md;
  }
}
