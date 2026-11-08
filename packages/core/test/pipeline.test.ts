import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
// @ts-expect-error — plain JS demo app
import { createApp } from "../../../examples/demo-app/server.mjs";
import { runVerification, type RunReport } from "../src/run.js";
import { parseConfig } from "../src/config.js";
import { UsageMeter } from "../src/usage.js";
import { renderMarkdownReport, COMMENT_MARKER } from "../src/report-md.js";
import { pullRequestFromEvent, statusFor, upsertPrComment } from "../src/github.js";
import type { VerificationContext } from "../src/context.js";
import { RunLog } from "../src/runlog.js";

const exec = promisify(execFile);
const ROOT = resolve(__dirname, "../../..");

/** Plays back JSON answers in order, one per model call. */
function scripted(answers: unknown[]) {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(answers[Math.min(i++, answers.length - 1)]) }],
      finishReason: "stop",
      usage: { inputTokens: 3000, outputTokens: 100, totalTokens: 3100 },
      warnings: [],
    }),
  });
}

const step = (o: object) => ({ thought: "scripted", ...o });

const ctx: VerificationContext = {
  ticket: { key: "PROJ-123", url: "https://acme.atlassian.net/browse/PROJ-123", summary: "Password reset via email", type: "Story", status: "In Review", description: "", comments: [] },
  criteria: [
    { id: "AC1", text: '"Forgot password?" link is visible on the login page', source: "section" },
    { id: "AC2", text: 'Registered email shows "Check your inbox"', source: "section" },
    { id: "AC3", text: "Unknown email shows the same message", source: "section" },
    { id: "AC4", text: "The reset link expires after 30 minutes", source: "section" },
  ],
  changes: { source: "github", base: "a", head: "b", branch: "feature/PROJ-123", files: [{ path: "server.mjs", status: "modified", additions: 20, deletions: 0 }], diff: "+…", truncated: false },
  warnings: [],
};

const scenario = (title: string, acIds: string[], extra: object = {}) => ({
  title, acIds, priority: "p1", role: "anonymous", startPath: "/login", steps: ["…"], expected: ["…"], ...extra,
});

let server: Server;
let baseUrl: string;
let dir: string;
let report: RunReport;
const runLog = new RunLog({ debug: true });

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-pipeline-"));

  const model = scripted([
    // review
    {
      coverage: [
        { acId: "AC1", status: "covered", evidence: [{ file: "server.mjs", note: "link" }], explanation: "Link added." },
        { acId: "AC2", status: "covered", evidence: [], explanation: "Message shown." },
        { acId: "AC3", status: "partial", evidence: [], explanation: "Different message for unknown emails." },
        { acId: "AC4", status: "missing", evidence: [], explanation: "No expiry logic in the diff." },
      ],
      risks: [{ area: "login", severity: "medium", files: ["server.mjs"], reason: "login page changed" }],
    },
    // plan
    {
      scenarios: [
        scenario("Link visible", ["AC1"]),
        scenario("Known email", ["AC2"]),
        scenario("Unknown email", ["AC3"]),
        scenario("Expiry", ["AC4"], { notTestableInBrowser: "requires waiting 30 minutes" }),
      ],
    },
    // S1 AC1
    step({ action: "assert", role: "link", name: "Forgot password?" }),
    step({ action: "done", verdict: "pass", reason: "Link 'Forgot password?' is visible" }),
    // S2 AC2
    step({ action: "click", role: "link", name: "Forgot password?" }),
    step({ action: "fill", role: "textbox", name: "Email", value: "ana@example.com" }),
    step({ action: "click", role: "button", name: "Send reset link" }),
    step({ action: "assert", value: "Check your inbox" }),
    step({ action: "done", verdict: "pass", reason: "Saw 'Check your inbox'" }),
    // S3 AC3
    step({ action: "click", role: "link", name: "Forgot password?" }),
    step({ action: "fill", role: "textbox", name: "Email", value: "nobody@example.com" }),
    step({ action: "click", role: "button", name: "Send reset link" }),
    step({ action: "done", verdict: "fail", reason: "Shows 'No account found for this email' | reveals accounts" }),
  ]);

  report = await runVerification({
    config: parseConfig({}),
    ctx,
    model: runLog.wrap(model),
    meter: new UsageMeter("claude-opus-5-5"),
    log: runLog,
    baseUrl,
    repoDir: ROOT,
    artifactsRoot: dir,
  });
}, 120_000);

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("runVerification (S4 pipeline)", () => {
  it("judges every acceptance criterion", () => {
    expect(report.verdict.criteria.map((c) => [c.acId, c.verdict])).toEqual([
      ["AC1", "pass"], ["AC2", "pass"], ["AC3", "fail"], ["AC4", "unverified"], // untestable + "missing in diff" → a human decides, never ❌ without browser evidence
    ]);
    expect(report.verdict.overall).toBe("fail");
  });

  it("replays passed scenarios without AI (E5-2)", () => {
    expect(report.results.filter((r) => r.verdict === "pass").map((r) => r.replay)).toEqual(["stable", "stable"]);
  });

  it("generates a Playwright spec that really passes (E5-1)", async () => {
    const t = report.generatedTests!;
    expect(t.scenarioIds).toEqual(["S1", "S2"]);
    expect(t.content).toContain('test("PROJ-123 AC2: Known email"');

    const specDir = await mkdtemp(join(ROOT, "packages/core/test/.gen-"));
    try {
      await writeFile(join(specDir, t.fileName), t.content);
      await writeFile(
        join(specDir, "playwright.config.mjs"),
        `export default { testDir: ".", reporter: "line", use: { baseURL: ${JSON.stringify(baseUrl)} } };`,
      );
      const { stdout } = await exec(join(ROOT, "node_modules/.bin/playwright"), ["test", "-c", join(specDir, "playwright.config.mjs")], { cwd: ROOT });
      expect(stdout).toMatch(/2 passed/);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("PR comment (E6-2)", () => {
  it("renders one table row per AC, escaped, with evidence link and tests", () => {
    const md = renderMarkdownReport(report, { artifactsUrl: "https://github.com/acme/web/actions/runs/1" });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)");
    expect(md).toContain("❌ Acceptance criteria not met** — 2/4");
    expect(md).toContain("| ❌ | **AC3**");
    expect(md).toContain("found for this email' \\| reveals"); // pipe escaped inside the table
    expect(md).toContain("```ts\n// Generated by Exhibit");
    expect(md).toContain("[Videos & traces](https://github.com/acme/web/actions/runs/1)");
  });

  it("edits the existing comment instead of adding a new one", async () => {
    const calls: [string, string][] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url]);
      if (init?.method === "GET" || !init?.method) {
        return new Response(JSON.stringify([{ id: 7, body: "unrelated" }, { id: 9, body: `${COMMENT_MARKER}\nold` }]), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/c/9" }), { status: 200 });
    }) as typeof fetch;
    const url = await upsertPrComment({ owner: "acme", repo: "web", token: "t", fetchImpl: fakeFetch }, 5, "new");
    expect(url).toBe("https://github.com/c/9");
    expect(calls[1]).toEqual(["PATCH", "https://api.github.com/repos/acme/web/issues/comments/9"]);
  });

  it("creates a comment when none exists", async () => {
    const methods: string[] = [];
    const fakeFetch = (async (_: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "POST"
        ? new Response(JSON.stringify({ html_url: "https://github.com/c/1" }), { status: 201 })
        : new Response("[]", { status: 200 });
    }) as typeof fetch;
    await upsertPrComment({ owner: "a", repo: "b", token: "t", fetchImpl: fakeFetch }, 1, "x");
    expect(methods).toEqual(["GET", "POST"]);
  });
});

describe("status (E6-3)", () => {
  it("is advisory in comment mode and blocking in check mode", () => {
    expect(statusFor(report.verdict, "comment")).toEqual({ state: "success", description: "1 of 4 acceptance criteria not met, 1 unverified (advisory)" });
    expect(statusFor(report.verdict, "check").state).toBe("failure");
  });
  it("reads the PR from the Actions event", () => {
    const pr = pullRequestFromEvent(
      { pull_request: { number: 12, title: "PROJ-1: x", body: null, head: { sha: "abc", ref: "feature/PROJ-1" } } },
      "acme/web",
    );
    expect(pr).toEqual({ owner: "acme", repo: "web", number: 12, headSha: "abc", branch: "feature/PROJ-1", title: "PROJ-1: x", body: undefined });
    expect(() => pullRequestFromEvent({}, "acme/web")).toThrow(/pull_request/);
  });
});

describe("run diagnostics", () => {
  it("records every model call and browser action with labels", () => {
    const calls = runLog.all.filter((e) => e.type === "llm_call");
    expect(calls.map((c) => (c as any).label).slice(0, 3)).toEqual(["review", "plan", "S1:step1"]);
    expect(calls).toHaveLength(13);
    const actions = runLog.all.filter((e) => e.type === "action");
    expect(actions.length).toBe(8);
    expect(runLog.all.filter((e) => e.type === "scenario_end")).toHaveLength(4);
  });

  it("writes events.jsonl, summary.md and full prompts in debug mode", async () => {
    const files = await readdir(report.runDir);
    expect(files).toEqual(expect.arrayContaining(["events.jsonl", "summary.md", "prompts", "report.json"]));
    const summary = await readFile(report.diagnostics!, "utf8");
    expect(summary).toContain("| review | 1 |");
    expect(summary).toMatch(/\| S3 Unknown email \| fail \| 4 \|/);
    const prompts = await readdir(join(report.runDir, "prompts"));
    expect(prompts[0]).toBe("001-review.json");
    expect(prompts).toHaveLength(13);
    const lines = (await readFile(join(report.runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines.every((l) => JSON.parse(l).ts)).toBe(true);
  });
});
