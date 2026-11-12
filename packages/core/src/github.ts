import { COMMENT_MARKER } from "./report-md.js";
import type { RunVerdict } from "./verdict.js";

export interface GitHubTarget {
  owner: string;
  repo: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/** A GitHub API answer that is not a success; `status` lets callers tell "not found" from a real failure. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** One GitHub REST call with Exhibit's headers. Throws GitHubError when the answer is not a success. */
export async function gh(t: GitHubTarget, method: string, path: string, body?: unknown): Promise<any> {
  const res = await (t.fetchImpl ?? fetch)(`${t.apiUrl ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "exhibit",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const hint = res.status === 403 ? " (does the workflow have `pull-requests: write` / `statuses: write` permissions?)" : "";
    throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status}${hint}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? undefined : res.json();
}

/** E6-2: one comment per PR, edited in place on every run. Returns its URL. */
export async function upsertPrComment(t: GitHubTarget, pr: number, body: string): Promise<string> {
  const base = `/repos/${t.owner}/${t.repo}`;
  for (let page = 1; page <= 10; page++) {
    const comments = (await gh(t, "GET", `${base}/issues/${pr}/comments?per_page=100&page=${page}`)) as any[];
    const mine = comments.find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
    if (mine) return (await gh(t, "PATCH", `${base}/issues/comments/${mine.id}`, { body })).html_url;
    if (comments.length < 100) break;
  }
  return (await gh(t, "POST", `${base}/issues/${pr}/comments`, { body })).html_url;
}

export type CommitState = "pending" | "success" | "failure" | "error";

/** E6-3: commit status shown next to the PR's checks. */
export async function setCommitStatus(
  t: GitHubTarget,
  sha: string,
  state: CommitState,
  description: string,
  targetUrl?: string,
): Promise<void> {
  await gh(t, "POST", `/repos/${t.owner}/${t.repo}/statuses/${sha}`, {
    state,
    context: "Exhibit",
    description: description.slice(0, 140),
    target_url: targetUrl,
  });
}

/**
 * `comment` mode never fails the status (advisory, builds trust first);
 * `check` mode fails it when an acceptance criterion is not met.
 */
export function statusFor(verdict: RunVerdict, mode: "comment" | "check"): { state: CommitState; description: string } {
  const passed = verdict.criteria.filter((c) => c.verdict === "pass").length;
  const total = verdict.criteria.length;
  const failed = verdict.criteria.filter((c) => c.verdict === "fail").length;
  const unverified = verdict.criteria.filter((c) => c.verdict === "unverified").length;
  const partial = verdict.criteria.filter((c) => c.verdict === "partial").length;
  const rest = [partial && `${partial} partly verified`, unverified && `${unverified} unverified`].filter(Boolean).join(", ");
  const description =
    verdict.overall === "pass"
      ? `${passed}/${total} acceptance criteria verified`
      : verdict.overall === "fail"
        ? `${failed} of ${total} acceptance criteria not met${rest ? `, ${rest}` : ""}`
        : `${passed}/${total} verified${rest ? `, ${rest}` : ""} — needs human review`;
  const state: CommitState = mode === "check" && verdict.overall === "fail" ? "failure" : "success";
  return { state, description: mode === "comment" && verdict.overall !== "pass" ? `${description} (advisory)` : description };
}

export interface PullRequestEvent {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  branch: string;
  title: string;
  body?: string;
}

/** Reads the PR from the GitHub Actions event payload. */
export function pullRequestFromEvent(event: any, repository: string | undefined): PullRequestEvent {
  const pr = event?.pull_request;
  if (!pr) throw new Error("This workflow was not triggered by a pull_request event (on: pull_request).");
  const [owner, repo] = (repository ?? event.repository?.full_name ?? "").split("/");
  if (!owner || !repo) throw new Error("Cannot tell the repository (GITHUB_REPOSITORY is not set).");
  return { owner, repo, number: pr.number, headSha: pr.head.sha, branch: pr.head.ref, title: pr.title, body: pr.body ?? undefined };
}
