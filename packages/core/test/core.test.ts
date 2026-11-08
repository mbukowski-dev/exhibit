import { describe, expect, it } from "vitest";
import { adfToText } from "../src/jira.js";
import { detectTicketKey } from "../src/ticket.js";
import { extractAcceptanceCriteria } from "../src/acceptance.js";
import { parseConfig, ConfigError } from "../src/config.js";
import { filterDiff, parsePrRef } from "../src/diff.js";
import { parseTicketMarkdown } from "../src/ticket-file.js";
import type { Ticket } from "../src/jira.js";

const ticket = (description: string, acceptanceField?: string): Ticket => ({
  key: "PROJ-1", url: "", summary: "s", type: "Story", status: "To Do", description, comments: [], acceptanceField,
});

describe("detectTicketKey (E1-1)", () => {
  it("finds the key in a branch name", () => {
    expect(detectTicketKey({ branch: "feature/PROJ-123-login" })).toBe("PROJ-123");
  });
  it("finds the key in a lowercase branch", () => {
    expect(detectTicketKey({ branch: "feature/proj-42-x" })).toBe("PROJ-42");
  });
  it("prefers the PR title over the branch", () => {
    expect(detectTicketKey({ prTitle: "ABC-9: Fix", branch: "feature/PROJ-1" })).toBe("ABC-9");
  });
  it("returns undefined when nothing matches", () => {
    expect(detectTicketKey({ branch: "main", prTitle: "Bump deps" })).toBeUndefined();
  });
});

describe("adfToText (E1-2)", () => {
  it("renders headings, paragraphs and lists", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance Criteria" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "User sees an error" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Email is sent" }] }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("## Acceptance Criteria\n\n- User sees an error\n- Email is sent");
  });
});

describe("extractAcceptanceCriteria (E1-3)", () => {
  it("reads a section in the description", () => {
    const ac = extractAcceptanceCriteria(
      ticket("Some context.\n\n## Acceptance Criteria\n- Login with valid password works\n- Wrong password shows an error\n\n## Notes\n- not an AC"),
    );
    expect(ac.map((a) => a.text)).toEqual(["Login with valid password works", "Wrong password shows an error"]);
    expect(ac[0]).toMatchObject({ id: "AC1", source: "section" });
  });
  it("supports the Polish heading and numbered lists", () => {
    const ac = extractAcceptanceCriteria(ticket("Kryteria akceptacji:\n1. Przycisk jest widoczny\n2) Klik zapisuje formularz"));
    expect(ac.map((a) => a.text)).toEqual(["Przycisk jest widoczny", "Klik zapisuje formularz"]);
  });
  it("prefers a dedicated custom field", () => {
    const ac = extractAcceptanceCriteria(ticket("## Acceptance Criteria\n- from description", "- from field"));
    expect(ac).toEqual([{ id: "AC1", text: "from field", source: "field" }]);
  });
  it("splits Gherkin scenarios", () => {
    const ac = extractAcceptanceCriteria(
      ticket("Given I am logged out\nWhen I open /admin\nThen I am redirected to /login\n\nGiven I am an admin\nWhen I open /admin\nThen I see the dashboard"),
    );
    expect(ac).toHaveLength(2);
    expect(ac[1]!.text).toContain("dashboard");
  });
  it("returns [] for prose-only tickets", () => {
    expect(extractAcceptanceCriteria(ticket("Make the login nicer please."))).toEqual([]);
  });
});

describe("parseConfig (E0-3)", () => {
  it("fills defaults", () => {
    expect(parseConfig({})).toMatchObject({ tracker: "jira", mode: "comment", model: { provider: "anthropic" } });
  });
  it("gives readable errors", () => {
    expect(() => parseConfig({ mode: "block", model: { provider: "x" } })).toThrow(ConfigError);
    try {
      parseConfig({ mode: "block" });
    } catch (e) {
      expect(String(e)).toContain("mode");
    }
  });
  it("rejects an invalid regex", () => {
    expect(() => parseConfig({ ticket_pattern: "[" })).toThrow(/ticket_pattern/);
  });
});

describe("diff helpers (E1-4)", () => {
  it("parses PR refs", () => {
    expect(parsePrRef("acme/web#12")).toEqual({ owner: "acme", repo: "web", number: 12 });
    expect(parsePrRef("https://github.com/acme/web/pull/7/files")).toEqual({ owner: "acme", repo: "web", number: 7 });
  });
  it("drops lockfiles from a diff", () => {
    const d = "diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+y\n";
    expect(filterDiff(d)).toBe("diff --git a/src/a.ts b/src/a.ts\n+x\n");
  });
});

describe("ticket file", () => {
  it("uses the first heading as summary", () => {
    const t = parseTicketMarkdown("# Login form\n\n## Acceptance Criteria\n- works", "PROJ-5");
    expect(t).toMatchObject({ key: "PROJ-5", summary: "Login form" });
    expect(extractAcceptanceCriteria(t)).toHaveLength(1);
  });
});
