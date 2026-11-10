import { describe, expect, it } from "vitest";
import { isForkPullRequest, skipReason } from "../src/skip.js";

const pr = (head: string | null, base = "acme/web") => ({
  pull_request: { head: { repo: head ? { full_name: head } : null }, base: { repo: { full_name: base } } },
});

describe("skipReason (E12-2)", () => {
  it("tells a fork from the repository's own branch", () => {
    expect(isForkPullRequest(pr("acme/web"))).toBe(false);
    expect(isForkPullRequest(pr("stranger/web"))).toBe(true);
    expect(isForkPullRequest(pr(null))).toBe(true); // the fork was deleted
    expect(isForkPullRequest({ pull_request: { head: {}, base: {} } })).toBe(false); // unknown: do not guess
  });

  it("skips when secrets cannot be there: forks and Dependabot", () => {
    expect(skipReason({ event: pr("stranger/web"), hasModelKey: false, hasTicket: true })?.reason).toBe("no_secrets");
    expect(skipReason({ event: pr("acme/web"), actor: "dependabot[bot]", hasModelKey: false, hasTicket: false })?.reason).toBe("no_secrets");
  });

  it("does not hide a missing key on the team's own pull request", () => {
    expect(skipReason({ event: pr("acme/web"), actor: "ana", hasModelKey: false, hasTicket: true })).toBeUndefined();
  });

  it("skips a pull request without a ticket key", () => {
    const s = skipReason({ event: pr("acme/web"), hasModelKey: true, hasTicket: false })!;
    expect(s.reason).toBe("no_ticket");
    expect(s.status.length).toBeLessThanOrEqual(140); // GitHub's limit for a status description
  });

  it("runs normally otherwise", () => {
    expect(skipReason({ event: pr("acme/web"), hasModelKey: true, hasTicket: true })).toBeUndefined();
    expect(skipReason({ event: pr("stranger/web"), hasModelKey: true, hasTicket: true })).toBeUndefined();
  });
});
