import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `exhibit ci` on an issue_comment event, the way the action runs it, against a
 * fake GitHub API. The child gets an explicit environment without any model key
 * and a working directory without a .env: accepting tests must not need either.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "packages/cli/src/index.ts");

const CODE = 'import { test } from "@playwright/test";\n\ntest("x", async () => {});';
const REPORT = `<!-- exhibit-report -->\n### Exhibit · PROJ-123\n\n<!-- exhibit-tests file="proj-123.exhibit.spec.ts" -->\n\`\`\`ts\n${CODE}\n\`\`\`\n<!-- /exhibit-tests -->\n`;

let api: Server;
let apiUrl: string;
let dir: string;
const requests: { method: string; path: string; body: any }[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url!.split("?")[0]!;
      requests.push({ method: req.method!, path, body: raw ? JSON.parse(raw) : undefined });
      const send = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (path.endsWith("/collaborators/ana/permission")) return send({ permission: "write" });
      if (path.endsWith("/pulls/7")) return send({ state: "open", head: { ref: "feature/PROJ-123", repo: { full_name: "acme/web" } } });
      if (path.endsWith("/issues/7/comments")) {
        return req.method === "GET" ? send([{ user: { login: "github-actions[bot]", type: "Bot" }, body: REPORT }]) : send({ html_url: "https://github.test/r" }, 201);
      }
      if (path.includes("/contents/")) return req.method === "GET" ? send({ message: "Not Found" }, 404) : send({ commit: { sha: "abc1234" } }, 201);
      send({ message: "unexpected" }, 500);
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-accept-"));
});
afterAll(async () => {
  api.close();
  await rm(dir, { recursive: true, force: true });
});

describe("exhibit ci on a pull request comment (E13-6)", () => {
  it("commits the tests for /accept-tests, without a model key, a preview or a browser", async () => {
    const eventPath = join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify({ issue: { number: 7, pull_request: {} }, comment: { body: "/accept-tests", user: { login: "ana" } } }));
    const result = await new Promise<{ code: number; out: string }>((done) => {
      execFile(
        TSX,
        ["--conditions=development", CLI, "ci", "-C", dir],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "",
            GITHUB_EVENT_NAME: "issue_comment",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_REPOSITORY: "acme/web",
            GITHUB_API_URL: apiUrl,
            GITHUB_TOKEN: "test-token",
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
          },
        },
        (err, stdout, stderr) => done({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr }),
      );
    });

    expect(result.out).toContain("Committed");
    expect(result.code).toBe(0);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/repos/acme/web/contents/tests/exhibit/proj-123.exhibit.spec.ts");
    expect(put.body.branch).toBe("feature/PROJ-123");
    expect(Buffer.from(put.body.content, "base64").toString("utf8")).toBe(CODE + "\n");
    expect(requests.some((r) => r.path.includes("/statuses/"))).toBe(false); // a comment sets no commit status
  }, 30_000);
});
