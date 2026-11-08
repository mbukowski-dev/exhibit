import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { chromium } from "playwright";
import { runScenario } from "../src/browser/agent.js";
import { executeAction } from "../src/browser/actions.js";
import { Secrets } from "../src/browser/secrets.js";
import { untrusted } from "../src/report-md.js";
import type { Scenario } from "../src/plan.js";

function scripted(actions: object[]) {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ thought: "scripted", ...actions[Math.min(i++, actions.length - 1)] }) }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

const serve = (html: (other: string) => string) =>
  new Promise<{ server: Server; url: string; setOther: (u: string) => void }>((resolve) => {
    let other = "";
    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(other));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, setOther: (u) => (other = u) }),
    );
  });

const scenario: Scenario = {
  id: "X1", title: "x", acIds: ["AC1"], priority: "p1", role: "anonymous", startPath: "/", steps: ["…"], expected: ["…"],
};

let app: Awaited<ReturnType<typeof serve>>;
let evil: Awaited<ReturnType<typeof serve>>;
let dir: string;

beforeAll(async () => {
  evil = await serve(() => `<h1>Evil</h1><form><label>Password <input name="p"></label></form>`);
  app = await serve((other) => `<h1>App</h1><a href="${other}/phish">Continue</a><label>Email <input name="e"></label>`);
  app.setOther(evil.url);
  dir = await mkdtemp(join(tmpdir(), "exhibit-sec-"));
});
afterAll(async () => {
  app.server.close();
  evil.server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("navigation guard", () => {
  it("blocks a clicked link to another origin and tells the agent", async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Continue" },
      { action: "done", verdict: "blocked", reason: "x" },
    ]);
    const r = await runScenario(scenario, { baseUrl: app.url, model, artifactsDir: dir });
    expect(r.steps[0]).toMatchObject({ ok: false });
    expect(r.steps[0]!.error).toMatch(/was blocked: it is outside the app under test/);
    expect(r.steps[0]!.url.startsWith(app.url)).toBe(true);
  }, 30_000);

  it("allows origins listed in allowed_origins (e.g. SSO)", async () => {
    const model = scripted([
      { action: "click", role: "link", name: "Continue" },
      { action: "done", verdict: "blocked", reason: "x" },
    ]);
    const r = await runScenario(scenario, { baseUrl: app.url, model, artifactsDir: dir, allowedOrigins: [evil.url] });
    expect(r.steps[0]).toMatchObject({ ok: true });
    expect(r.steps[0]!.url.startsWith(evil.url)).toBe(true);
  }, 30_000);

  it("refuses to type credentials outside the app", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(evil.url);
      const r = await executeAction(
        page,
        { thought: "", action: "fill", role: "textbox", name: "Password", value: "{{password}}" },
        { baseUrl: app.url, secrets: new Secrets({ password: "hunter22" }), canTypeSecretsAt: (u) => u.startsWith(app.url) },
      );
      expect(r).toMatchObject({ ok: false });
      expect(r.error).toMatch(/Refused to type credentials/);
      expect(await page.locator("input").inputValue()).toBe("");
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("evidence never contains credentials", () => {
  it("does not record a Playwright trace when credentials are in play", async () => {
    const model = scripted([
      { action: "fill", role: "textbox", name: "Email", value: "{{username}}" },
      { action: "done", verdict: "blocked", reason: "x" },
    ]);
    const withSecrets = await runScenario({ ...scenario, id: "X2" }, { baseUrl: app.url, model, artifactsDir: dir, secrets: new Secrets({ username: "ana@example.com" }) });
    expect(withSecrets.steps[0]).toMatchObject({ ok: true });
    expect(withSecrets.artifacts.trace).toBeUndefined();
    expect(withSecrets.artifacts.video).toBeDefined();

    const plain = await runScenario({ ...scenario, id: "X3" }, { baseUrl: app.url, model: scripted([{ action: "done", verdict: "blocked", reason: "x" }]), artifactsDir: dir });
    expect(plain.artifacts.trace).toBeDefined();
  }, 30_000);
});

describe("PR comment sanitizing", () => {
  it("neutralizes mentions, HTML, images, links and code breakouts", () => {
    const evilText = 'Ping @octocat <img src=x onerror=alert(1)> ![x](https://e.vil/a.png) [click](https://e.vil) ```';
    const out = untrusted(evilText);
    expect(out).not.toMatch(/@octocat/);
    expect(out).not.toContain("<img");
    expect(out).toContain("\\[click\\](https://e.vil)"); // escaped: renders as text, not a link
    expect(out).toContain("\\!\\[x\\]"); // no image
    expect(out).not.toContain("```");
    expect(out).toContain("&lt;img");
  });
});
