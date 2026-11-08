import type { RunReport } from "./run.js";

/** Hidden marker that lets us find and update our own PR comment (E6-2). */
export const COMMENT_MARKER = "<!-- exhibit-report -->";

const ICON = { pass: "✅", partial: "🟡", fail: "❌", unverified: "⚠️" } as const;
const SCENARIO_ICON = { pass: "✅", fail: "❌", blocked: "⛔" } as const;
const COVERAGE = { covered: "✅ covered", partial: "🟡 partial", missing: "❌ missing", unclear: "❔ unclear" } as const;
const HEADLINE = {
  pass: "✅ All acceptance criteria verified",
  fail: "❌ Acceptance criteria not met",
  needs_review: "⚠️ Needs human review",
} as const;

/**
 * Text that came from the model, the page under test, the ticket or the PR is
 * untrusted: it must not ping people (@mentions), render HTML, images or
 * links, or break out of the comment's structure.
 */
export function untrusted(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200B") // no notifications
    .replace(/([[\]!])/g, "\\$1") // no markdown links or images
    .replace(/`/g, "'"); // no breaking out of inline code
}

/** Table cells: untrusted text without pipes or newlines, bounded length. */
const cell = (s: string, max = 300) => {
  const t = untrusted(s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** One line of untrusted text. */
const line = (s: string, max = 600) => cell(s, max);

/** A fenced block that the content cannot close early. */
function fence(content: string, lang = ""): string[] {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return [f + lang, content, f];
}

export interface MarkdownLinks {
  /** Where videos/traces can be downloaded (e.g. the Actions run page). */
  artifactsUrl?: string;
}

export function renderMarkdownReport(r: RunReport, links: MarkdownLinks = {}): string {
  const v = r.verdict;
  const passed = v.criteria.filter((c) => c.verdict === "pass").length;
  const partial = v.criteria.filter((c) => c.verdict === "partial").length;
  const ticket = r.ticket.url && /^https:\/\//.test(r.ticket.url) ? `[${line(r.ticket.key, 40)}](${encodeURI(r.ticket.url)})` : line(r.ticket.key, 40);
  const out: string[] = [COMMENT_MARKER];

  out.push(`### Exhibit · ${ticket} ${line(r.ticket.summary, 200)}`);
  out.push(`**${HEADLINE[v.overall]}** — ${passed}/${v.criteria.length} acceptance criteria verified${partial ? `, ${partial} partly` : ""}`);
  out.push("");
  out.push("| | Acceptance criterion | Evidence |", "|---|---|---|");
  for (const c of v.criteria) {
    out.push(`| ${ICON[c.verdict]} | **${c.acId}** ${cell(c.text, 160)} | ${cell(c.summary)} |`);
  }

  if (r.review.coverage.length || r.review.risks.length) {
    out.push("", "<details><summary>Code review against the ticket</summary>", "");
    for (const c of r.review.coverage) {
      const files = c.evidence.map((e) => `\`${line(e.file, 120)}\``).join(", ");
      out.push(`- **${line(c.acId, 20)}** ${COVERAGE[c.status]} — ${line(c.explanation)}${files ? ` (${files})` : ""}`);
    }
    if (r.review.risks.length) {
      out.push("", "**Risk areas**");
      for (const k of r.review.risks) out.push(`- \`${k.severity}\` ${line(k.area, 80)} — ${line(k.reason)}`);
    }
    out.push("", "</details>");
  }

  out.push("", `<details><summary>Scenarios (${r.results.length})</summary>`, "");
  for (const s of r.results) {
    const replay = s.replay ? ` · replay: ${s.replay}` : "";
    out.push(`**${SCENARIO_ICON[s.verdict]} ${s.scenarioId} ${line(s.title, 160)}** _(${s.acIds.join(", ") || "regression"} · ${s.steps.length} steps${replay})_`);
    if (s.reason) out.push(`> ${line(s.reason)}`);
    const errs = [...s.failedRequests, ...s.consoleErrors].slice(0, 3);
    if (errs.length) out.push("", ...fence(errs.join("\n")));
    out.push("");
  }
  if (r.plan.skipped.length) out.push(`_Not run (limit \`max_scenarios\`): ${line(r.plan.skipped.map((s) => s.title).join("; "))}_`, "");
  out.push("</details>");

  if (r.generatedTests) {
    const n = r.generatedTests.scenarioIds.length;
    out.push(
      "",
      `<details><summary>🧪 ${n} generated Playwright test${n > 1 ? "s" : ""} — <code>${r.generatedTests.fileName}</code></summary>`,
      "",
      ...fence(r.generatedTests.content.trimEnd(), "ts"),
      "</details>",
    );
  }

  if (r.warnings.length) out.push("", ...r.warnings.map((w) => `> ⚠️ ${line(w)}`));

  const cost = `${r.usage.priceKnown ? "" : "≤"}$${r.usage.costUsd.toFixed(2)}`;
  const evidence = links.artifactsUrl ? `📎 [Videos & traces](${links.artifactsUrl}) · ` : "";
  out.push("", `<sub>${evidence}${cost} · ${Math.round(r.durationMs / 1000)}s · ${r.usage.model} · tested ${line(r.baseUrl, 200)}</sub>`);
  return out.join("\n");
}
