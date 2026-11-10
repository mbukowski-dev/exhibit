import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { parseConfig } from "../src/config.js";
import { buildContext, type VerificationContext } from "../src/context.js";
import { planVerification } from "../src/plan.js";
import { renderContext } from "../src/prompt.js";
import { reviewChanges } from "../src/review.js";

const NOTES = "Registered test account: ana@example.com.\nNever submit the payment form: it charges a real sandbox card.";

const ctx: VerificationContext = {
  ticket: { key: "PROJ-123", url: "", summary: "Password reset", type: "", status: "", description: "", comments: [] },
  criteria: [{ id: "AC1", text: "Forgot password link on login page", source: "section" }],
  changes: {
    source: "git", base: "abc", head: "HEAD", branch: "feature/proj-123",
    files: [{ path: "login.tsx", status: "modified", additions: 1, deletions: 0 }],
    diff: "+<a href=\"/forgot\">Forgot password?</a>", truncated: false,
  },
  warnings: [],
};

function mockModel(obj: unknown) {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: "stop",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
      warnings: [],
    }),
  });
}
const sent = (model: MockLanguageModelV2) => JSON.stringify(model.doGenerateCalls[0]!.prompt);

describe("agent_notes reach every stage, not only the browser agent (E12-15)", () => {
  it("carries agent_notes from .exhibit.yml into the verification context", async () => {
    const built = await buildContext({
      config: parseConfig({ agent_notes: NOTES }),
      changes: { ...ctx.changes, title: "PROJ-123: password reset" },
      fetchTicket: async () => ({ ...ctx.ticket, description: "Acceptance Criteria\n- Forgot password link on login page" }),
    });
    expect(built.notes).toBe(NOTES);
  });

  it("gives them to the planner, which otherwise plans without knowing the test accounts or what not to touch", async () => {
    const model = mockModel({ scenarios: [] });
    await planVerification({ ...ctx, notes: NOTES }, { coverage: [], risks: [] }, model);
    expect(sent(model)).toContain("ana@example.com");
    expect(sent(model)).toContain("Never submit the payment form");
    // The planner is told what the notes are — and that they cannot drop a criterion.
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt[0])).toMatch(/test_data_notes[^.]*\./);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt[0])).toContain("never remove an acceptance criterion");
  });

  it("gives them to the review as background", async () => {
    const model = mockModel({ coverage: [], risks: [] });
    await reviewChanges({ ...ctx, notes: NOTES }, model);
    expect(sent(model)).toContain("ana@example.com");
  });

  it("adds nothing when there are no notes", () => {
    expect(renderContext(ctx)).not.toContain("test_data_notes");
    expect(renderContext({ ...ctx, notes: "  " })).not.toContain("test_data_notes");
  });

  it("keeps the notes apart from the ticket and the diff", () => {
    const text = renderContext({ ...ctx, notes: NOTES });
    expect(text).toMatch(/<test_data_notes>\nRegistered test account: ana@example\.com\.\nNever submit[^<]*\n<\/test_data_notes>/);
    expect(text.indexOf("</ticket>")).toBeLessThan(text.indexOf("<test_data_notes>"));
  });
});
