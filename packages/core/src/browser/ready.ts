/**
 * E4-5: waits until the preview environment answers (any status < 500),
 * so a run started right after `git push` does not fail on a cold deploy.
 */
export async function waitForUrl(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const { timeoutMs = 180_000, intervalMs = 3_000, fetchImpl = fetch } = opts;
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Preview ${url} was not ready after ${Math.round(timeoutMs / 1000)}s (last: ${last})`);
}

/** Expands `{pr}`, `{branch}` and `{sha}` in a preview URL template. */
export function expandPreviewUrl(template: string, vars: { pr?: number | string; branch?: string; sha?: string }) {
  return template.replace(/\{(pr|branch|sha)\}/g, (_, k: "pr" | "branch" | "sha") => {
    const v = vars[k];
    if (v === undefined || v === "") throw new Error(`preview_url uses {${k}} but it is not known for this run`);
    // Vercel-style branch slugs: lowercase, non-alphanumerics → "-"
    return k === "branch" ? String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-") : String(v);
  });
}
