import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { replayScenario, runScenario } from "../src/browser/agent.js";
import type { AgentAction } from "../src/browser/actions.js";
import { generateTests } from "../src/codegen.js";
import type { Scenario } from "../src/plan.js";

/** An app that asks before deleting, like most real ones do. */
const PAGE = `<!doctype html><html lang="en"><head><title>Invoices</title></head><body>
<h1>Invoices</h1>
<ul><li id="item">Invoice 7
  <button onclick="if (confirm('Delete Invoice 7?')) { document.getElementById('item').remove(); document.getElementById('status').textContent = 'Invoice 7 deleted'; }">Delete</button>
</li></ul>
<p role="status" id="status"></p>
</body></html>`;

function scripted(actions: Partial<AgentAction>[]) {
  let i = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ thought: "scripted", ...actions[Math.min(i++, actions.length - 1)] }) }],
      finishReason: "stop",
      usage: { inputTokens: 2000, outputTokens: 50, totalTokens: 2050 },
      warnings: [],
    }),
  });
}

const scenario: Scenario = {
  id: "S1", title: "Delete an invoice", acIds: ["AC1"], priority: "p1", role: "anonymous", startPath: "/",
  steps: ["Click Delete next to Invoice 7 and confirm"], expected: ["'Invoice 7 deleted' is shown"],
};

let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "exhibit-dialogs-"));
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("browser dialogs: confirm / alert (E12-1)", () => {
  it("accepts a confirm() like a tester would, and tells the agent what it said", async () => {
    const model = scripted([
      { action: "click", role: "button", name: "Delete" },
      { action: "assert", value: "Invoice 7 deleted" },
      { action: "done", verdict: "pass", reason: "Saw 'Invoice 7 deleted'" },
    ]);
    const r = await runScenario(scenario, { baseUrl, model, artifactsDir: dir });

    // Unhandled, Playwright dismisses the dialog: nothing is deleted and a working app looks broken.
    expect(r.verdict).toBe("pass");
    expect(r.steps[0]!.dialogs).toEqual([{ type: "confirm", message: "Delete Invoice 7?" }]);
    const secondPrompt = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(secondPrompt).toContain("Delete Invoice 7?");
    expect(secondPrompt).toContain("accepted");
  }, 30_000);

  it("replays the scenario and generates a test that accepts the dialog too", async () => {
    const model = scripted([
      { action: "click", role: "button", name: "Delete" },
      { action: "assert", value: "Invoice 7 deleted" },
      { action: "done", verdict: "pass", reason: "Saw 'Invoice 7 deleted'" },
    ]);
    const r = await runScenario(scenario, { baseUrl, model, artifactsDir: dir });
    r.replay = await replayScenario(r, scenario, { baseUrl });
    expect(r.replay).toBe("stable");

    const tests = generateTests("PROJ-9", [scenario], [r])!;
    const lines = tests.content.split("\n");
    const handler = lines.findIndex((l) => l.includes('page.on("dialog"'));
    const click = lines.findIndex((l) => l.includes(".click()"));
    expect(handler).toBeGreaterThan(-1);
    expect(handler).toBeLessThan(click); // registered before the click that opens the dialog
  }, 30_000);

  it("leaves tests of scenarios without dialogs unchanged", async () => {
    const quiet = { ...scenario, id: "S2" };
    const model = scripted([{ action: "assert", value: "Invoices" }, { action: "done", verdict: "pass", reason: "Heading shown" }]);
    const r = await runScenario(quiet, { baseUrl, model, artifactsDir: dir });
    r.replay = "stable";
    expect(generateTests("PROJ-9", [quiet], [r])!.content).not.toContain("dialog");
  }, 30_000);
});
