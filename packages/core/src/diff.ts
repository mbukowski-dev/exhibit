import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
}

export interface ChangeSet {
  source: "git" | "github";
  base: string;
  head: string;
  branch?: string;
  title?: string;
  body?: string;
  files: ChangedFile[];
  /** Unified diff, truncated to `maxDiffChars`. */
  diff: string;
  truncated: boolean;
}

/** Raw safety cap while fetching; the model-facing budget is applied by budgetDiff. */
const MAX_DIFF_CHARS = 2_000_000;

/** Lockfiles and build output add noise and tokens, never meaning. */
const IGNORED = [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/, /(^|\/)(dist|build|\.next)\//, /\.min\.(js|css)$/, /\.snap$/];
export const isIgnoredPath = (p: string) => IGNORED.some((r) => r.test(p));

function truncate(diff: string, max: number) {
  return diff.length > max
    ? { diff: diff.slice(0, max) + "\n… [diff truncated]", truncated: true }
    : { diff, truncated: false };
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Local mode: diff between merge-base(base, HEAD) and the working tree's HEAD. */
export async function localChangeSet(
  cwd: string,
  base = "main",
  maxDiffChars = MAX_DIFF_CHARS,
): Promise<ChangeSet> {
  const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const mergeBase = (await git(cwd, "merge-base", base, "HEAD")).trim();
  const numstat = await git(cwd, "diff", "--numstat", "-M", mergeBase, "HEAD");
  const nameStatus = await git(cwd, "diff", "--name-status", "-M", mergeBase, "HEAD");

  const statusByPath = new Map<string, ChangedFile["status"]>();
  for (const line of nameStatus.trim().split("\n").filter(Boolean)) {
    const [code, ...paths] = line.split("\t");
    const path = paths[paths.length - 1]!;
    const c = code?.[0];
    statusByPath.set(path, c === "A" ? "added" : c === "D" ? "removed" : c === "R" ? "renamed" : "modified");
  }

  const files: ChangedFile[] = numstat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, ...rest] = line.split("\t");
      // renamed: "old => new" or "dir/{a => b}/f"
      const raw = rest.join("\t");
      const path = raw.includes("=>")
        ? raw.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "")
        : raw;
      return {
        path,
        status: statusByPath.get(path) ?? "modified",
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
      };
    });

  const relevant = files.filter((f) => !isIgnoredPath(f.path)).map((f) => f.path);
  const fullDiff = relevant.length
    ? await git(cwd, "diff", "-M", "--unified=5", mergeBase, "HEAD", "--", ...relevant)
    : "";

  const title = (await git(cwd, "log", "-1", "--format=%s")).trim();
  return { source: "git", base: mergeBase, head: "HEAD", branch, title, files, ...truncate(fullDiff, maxDiffChars) };
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** Accepts `owner/repo#12` or a github.com PR URL. */
export function parsePrRef(input: string): PullRequestRef {
  const m =
    input.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/) ??
    input.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Cannot parse PR reference "${input}". Use owner/repo#123 or a PR URL.`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

export async function githubChangeSet(
  ref: PullRequestRef,
  token: string | undefined,
  maxDiffChars = MAX_DIFF_CHARS,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangeSet> {
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const headers: Record<string, string> = {
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "exhibit-cli",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const prRes = await fetchImpl(api, { headers: { ...headers, Accept: "application/vnd.github+json" } });
  if (!prRes.ok) throw new Error(`GitHub API error ${prRes.status} for ${ref.owner}/${ref.repo}#${ref.number}`);
  const pr = (await prRes.json()) as any;

  const files: ChangedFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetchImpl(`${api}/files?per_page=100&page=${page}`, {
      headers: { ...headers, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`GitHub API error ${r.status} listing PR files`);
    const batch = (await r.json()) as any[];
    for (const f of batch) {
      files.push({ path: f.filename, status: f.status === "removed" ? "removed" : f.status === "added" ? "added" : f.status === "renamed" ? "renamed" : "modified", additions: f.additions, deletions: f.deletions });
    }
    if (batch.length < 100) break;
  }

  const diffRes = await fetchImpl(api, { headers: { ...headers, Accept: "application/vnd.github.diff" } });
  if (!diffRes.ok) throw new Error(`GitHub API error ${diffRes.status} fetching diff`);
  const diff = filterDiff(await diffRes.text());

  return {
    source: "github",
    base: pr.base?.sha,
    head: pr.head?.sha,
    branch: pr.head?.ref,
    title: pr.title,
    body: pr.body ?? undefined,
    files,
    ...truncate(diff, maxDiffChars),
  };
}

/** Drops per-file sections of ignored paths from a unified diff. */
export function filterDiff(diff: string): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const m = section.match(/^diff --git a\/(\S+) b\/(\S+)/);
      return !m || !isIgnoredPath(m[2]!);
    })
    .join("");
}
