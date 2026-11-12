import type { ExhibitConfig } from "./config.js";
import { gh, GitHubError, type GitHubTarget } from "./github.js";
import { COMMENT_MARKER, untrusted } from "./report-md.js";

/**
 * E13-6 / E5-3: a `/accept-tests` comment on a pull request commits the tests
 * Exhibit generated to that pull request's branch.
 *
 * It runs on an `issue_comment` event, which GitHub starts from the default
 * branch with the workflow's secrets — so nothing here trusts the comment:
 *  - the person who asked must have write access to the repository;
 *  - the test code is taken only from Exhibit's own report (a comment written
 *    by a bot, or by someone with write access), never from the request;
 *  - pull requests from forks are refused;
 *  - the file name comes from the report and must look like a generated test,
 *    and the folder comes from .exhibit.yml on the default branch.
 */
export const ACCEPT_COMMAND = "/accept-tests";

const TEST_FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.exhibit\.spec\.ts$/;

/**
 * The generated tests inside an Exhibit report, or undefined when the report has none.
 * The report wraps them in hidden markers (see report-md.ts), so this does not depend on its wording or language.
 */
export function extractGeneratedTests(reportBody: string): { fileName: string; content: string } | undefined {
  const m = reportBody.match(/<!-- exhibit-tests file="([^"\n]+)" -->\n(`{3,})ts\n([\s\S]*?)\n\2\n<!-- \/exhibit-tests -->/);
  if (!m || !TEST_FILE.test(m[1]!)) return undefined;
  return { fileName: m[1]!, content: m[3]! + "\n" };
}

export interface AcceptResult {
  /** ignored: not a request for us, nothing was said or done. */
  outcome: "committed" | "unchanged" | "refused" | "ignored";
  /** What was (or would have been) replied in the pull request. */
  message: string;
  path?: string;
  commitSha?: string;
}

const code = (s: string) => `\`${untrusted(s)}\``;
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** True when the user may push to the repository. Anything unclear counts as no. */
async function canWrite(t: GitHubTarget, login: string, cache: Map<string, boolean>): Promise<boolean> {
  if (cache.has(login)) return cache.get(login)!;
  let ok = false;
  try {
    const r = await gh(t, "GET", `/repos/${t.owner}/${t.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    ok = r?.permission === "admin" || r?.permission === "write";
  } catch {
    ok = false;
  }
  cache.set(login, ok);
  return ok;
}

/** Exhibit's latest report on the pull request, from an author we can trust. */
async function findReport(t: GitHubTarget, pr: number, cache: Map<string, boolean>): Promise<string | undefined> {
  let found: string | undefined;
  for (let page = 1; page <= 10; page++) {
    const comments = (await gh(t, "GET", `/repos/${t.owner}/${t.repo}/issues/${pr}/comments?per_page=100&page=${page}`)) as any[];
    for (const c of comments) {
      if (typeof c.body !== "string" || !c.body.includes(COMMENT_MARKER)) continue;
      // Anyone can post a comment that contains the marker. Only a bot (the workflow) or a person
      // who could push the file anyway may be the source of code that gets committed.
      if (c.user?.type === "Bot" || (c.user?.login && (await canWrite(t, c.user.login, cache)))) found = c.body;
    }
    if (comments.length < 100) break;
  }
  return found;
}

export async function acceptTests(t: GitHubTarget, event: any, config: Pick<ExhibitConfig, "tests">): Promise<AcceptResult> {
  const body: string = event?.comment?.body ?? "";
  const pr: number | undefined = event?.issue?.number;
  if (!event?.issue?.pull_request || !pr || !body.trim().startsWith(ACCEPT_COMMAND)) {
    return { outcome: "ignored", message: "Not an /accept-tests comment on a pull request." };
  }
  const base = `/repos/${t.owner}/${t.repo}`;
  const reply = async (r: AcceptResult): Promise<AcceptResult> => {
    await gh(t, "POST", `${base}/issues/${pr}/comments`, { body: r.message }).catch(() => {});
    return r;
  };
  const refuse = (message: string) => reply({ outcome: "refused", message: `⛔ ${ACCEPT_COMMAND}: ${message}` });

  const cache = new Map<string, boolean>();
  const who: string = event.comment?.user?.login ?? "";
  if (!who || !(await canWrite(t, who, cache))) {
    return refuse("only people with write access to this repository can accept tests.");
  }

  const pull = await gh(t, "GET", `${base}/pulls/${pr}`);
  if (pull.state !== "open") return refuse("this pull request is closed.");
  if (pull.head?.repo?.full_name !== `${t.owner}/${t.repo}`) {
    return refuse("this pull request comes from a fork, and Exhibit does not push to forks. Copy the tests from the report instead.");
  }
  const branch: string = pull.head.ref;

  const report = await findReport(t, pr, cache);
  const tests = report ? extractGeneratedTests(report) : undefined;
  if (!tests) {
    return refuse(
      report
        ? "the latest Exhibit report has no generated tests. Tests are generated only from scenarios that passed and replayed without AI; if the report is from an older version of Exhibit, push again to get a new one."
        : "there is no Exhibit report on this pull request yet.",
    );
  }

  const path = `${config.tests.dir}/${tests.fileName}`;
  const url = `${base}/contents/${encodePath(path)}`;
  let existingSha: string | undefined;
  try {
    const existing = await gh(t, "GET", `${url}?ref=${encodeURIComponent(branch)}`);
    existingSha = existing?.sha;
    if (typeof existing?.content === "string" && Buffer.from(existing.content, "base64").toString("utf8") === tests.content) {
      return reply({ outcome: "unchanged", path, message: `${code(path)} on ${code(branch)} already has these tests. Nothing to commit.` });
    }
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 404) throw e;
  }

  const key = tests.fileName.replace(/\.exhibit\.spec\.ts$/, "").toUpperCase();
  let commitSha: string;
  try {
    const put = await gh(t, "PUT", url, {
      message: `Add tests generated by Exhibit for ${key}`,
      content: Buffer.from(tests.content, "utf8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });
    commitSha = put?.commit?.sha ?? "";
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) {
      return refuse("Exhibit may not write to this repository. The job that handles this comment needs `permissions: contents: write` (see docs/github-action.md).");
    }
    throw e;
  }

  return reply({
    outcome: "committed",
    path,
    commitSha,
    message:
      `✅ Committed ${code(path)} to ${code(branch)}${commitSha ? ` (${commitSha.slice(0, 7)})` : ""}, as asked by ${code(who)}. ` +
      `Run it with \`npx playwright test ${config.tests.dir}\`.\n\n` +
      "A commit made by a workflow does not start other workflows, so your CI has not run on it yet: push again or re-run your checks.",
  });
}
