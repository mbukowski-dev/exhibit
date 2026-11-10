import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs `exhibit ci` the way the action does, against a fake GitHub API.
 * The child gets an explicit environment (no inherited keys) and a working
 * directory without a .env, so no real credential can reach it.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "packages/cli/src/index.ts");

let api: Server;
let apiUrl: string;
let dir: string;
let requests: { method: string; path: string; body: any }[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(req.method === "GET" ? 200 : 201, { "content-type": "application/json" });
      res.end(req.method === "GET" ? "[]" : JSON.stringify({ html_url: "https://github.test/comment" }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-ci-"));
});
afterAll(async () => {
  api.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
});

const event = (o: { title?: string; branch?: string; headRepo?: string } = {}) => ({
  pull_request: {
    number: 7,
    title: o.title ?? "PROJ-123: password reset",
    body: "",
    head: { sha: "a".repeat(40), ref: o.branch ?? "feature/PROJ-123-reset", repo: { full_name: o.headRepo ?? "acme/web" } },
    base: { repo: { full_name: "acme/web" } },
  },
});

async function ci(ev: object, env: Record<string, string>) {
  const eventPath = join(dir, "event.json");
  const outputPath = join(dir, "output.txt");
  await writeFile(eventPath, JSON.stringify(ev));
  await writeFile(outputPath, "");
  const result = await new Promise<{ code: number; out: string }>((done) => {
    execFile(
      TSX,
      // A preview URL nothing listens on: a skipped run must end before it would wait for it.
      ["--conditions=development", CLI, "ci", "-C", dir, "-o", join(dir, "artifacts"), "--url", "http://127.0.0.1:9", "--preview-timeout", "1"],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "acme/web",
          GITHUB_API_URL: apiUrl,
          GITHUB_TOKEN: "test-token",
          GITHUB_ACTOR: "ana",
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          ...env,
        },
      },
      (err, stdout, stderr) => done({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
  return { ...result, output: await readFile(outputPath, "utf8") };
}

const comments = () => requests.filter((r) => r.path.includes("/comments") && r.method !== "GET");
const statuses = () => requests.filter((r) => r.path.includes("/statuses/")).map((r) => r.body);

describe("exhibit ci: pull requests it cannot or need not verify (E12-2)", () => {
  it("skips a pull request from a fork (no secrets) without failing the job", async () => {
    const r = await ci(event({ headRepo: "stranger/web" }), {});
    expect(r.out).toContain("::notice");
    expect(r.out).toMatch(/fork/);
    expect(r.code).toBe(0);
    expect(comments()).toEqual([]);
    expect(r.output).toContain("verdict=skipped");
  }, 30_000);

  it("skips a Dependabot pull request (no secrets) without failing the job", async () => {
    const r = await ci(event({ title: "Bump lodash from 4.17.20 to 4.17.21", branch: "dependabot/npm_and_yarn/lodash-4.17.21" }), { GITHUB_ACTOR: "dependabot[bot]" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Dependabot/);
    expect(comments()).toEqual([]);
  }, 30_000);

  it("still fails loudly when the team's own pull request has no model key (a setup mistake)", async () => {
    const r = await ci(event(), {});
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs a model key/);
  }, 30_000);

  it("skips a pull request without a ticket key: green status, no comment, no model call", async () => {
    const r = await ci(event({ title: "Update the README", branch: "chore/readme" }), { OPENAI_API_KEY: "sk-test-not-a-real-key" });
    expect(r.code).toBe(0);
    expect(comments()).toEqual([]);
    expect(statuses()).toHaveLength(1); // no "pending" first: nothing is going to be verified
    expect(statuses()[0]).toMatchObject({ state: "success", context: "Exhibit" });
    expect(statuses()[0].description).toMatch(/^Skipped: no ticket key/);
    expect(r.output).toContain("verdict=skipped");
  }, 30_000);
});
