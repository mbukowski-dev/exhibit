import type { ScenarioResult } from "./browser/agent.js";
import { labelsFor } from "./language.js";
import type { RunReport } from "./run.js";

/** Hidden marker that lets us find and update our own PR comment (E6-2). */
export const COMMENT_MARKER = "<!-- exhibit-report -->";

const ICON = { pass: "✅", partial: "🟡", fail: "❌", unverified: "⚠️" } as const;
const SCENARIO_ICON = { pass: "✅", fail: "❌", blocked: "⛔" } as const;

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

/**
 * E13-2: what would unblock the blocked scenarios — outside the collapsed
 * details, because it is the part of the report someone has to act on.
 * Scenarios that need the same thing share one entry (and one config snippet).
 */
export function renderHints(results: Pick<ScenarioResult, "scenarioId" | "verdict" | "hint">[], language?: string): string[] {
  const groups = new Map<string, { ids: string[]; text: string; snippet?: string }>();
  for (const r of results) {
    if (r.verdict !== "blocked" || !r.hint) continue;
    const key = `${r.hint.text}\n${r.hint.snippet ?? ""}`;
    const g = groups.get(key) ?? { ids: [], text: r.hint.text, snippet: r.hint.snippet };
    g.ids.push(cell(r.scenarioId, 12));
    groups.set(key, g);
  }
  if (!groups.size) return [];
  const out = ["", `**${labelsFor(language).unblock}**`, ""];
  for (const g of groups.values()) {
    out.push(`- **${g.ids.join(", ")}:** ${g.text}`);
    // Indented as a whole, so the block belongs to the list item and the YAML keeps its own nesting.
    if (g.snippet) out.push("", ...fence(g.snippet, "yaml").join("\n").split("\n").map((l) => "  " + l), "");
  }
  return out;
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
  // The fixed words of the report follow `language` in .exhibit.yml (English and Polish are built in).
  const L = labelsFor(r.language);

  out.push(`### Exhibit · ${ticket} ${line(r.ticket.summary, 200)}`);
  out.push(`**${L[v.overall]}** — ${L.verified(passed, v.criteria.length, partial)}`);
  out.push("");
  out.push(`| | ${L.criterion} | ${L.evidence} |`, "|---|---|---|");
  for (const c of v.criteria) {
    const ac = r.criteria.find((a) => a.id === c.acId);
    const changed = ac?.changedBy ? ` <br>✏️ _${L.changed(cell(ac.changedBy.author, 60), ac.changedBy.created.slice(0, 10))}_` : "";
    out.push(`| ${ICON[c.verdict]} | **${c.acId}** ${cell(c.text, 160)}${changed} | ${cell(c.summary)} |`);
  }

  out.push(...renderHints(r.results, r.language));

  if (r.review.coverage.length || r.review.risks.length) {
    out.push("", `<details><summary>${L.review}</summary>`, "");
    for (const c of r.review.coverage) {
      const files = c.evidence.map((e) => `\`${line(e.file, 120)}\``).join(", ");
      out.push(`- **${line(c.acId, 20)}** ${L.coverage[c.status]} — ${line(c.explanation)}${files ? ` (${files})` : ""}`);
    }
    if (r.review.risks.length) {
      out.push("", `**${L.risks}**`);
      for (const k of r.review.risks) out.push(`- \`${k.severity}\` ${line(k.area, 80)} — ${line(k.reason)}`);
    }
    out.push("", "</details>");
  }

  out.push("", `<details><summary>${L.scenarios} (${r.results.length})</summary>`, "");
  for (const s of r.results) {
    const replay = s.replay ? ` · replay: ${s.replay}` : "";
    out.push(`**${SCENARIO_ICON[s.verdict]} ${s.scenarioId} ${line(s.title, 160)}** _(${s.acIds.join(", ") || L.regression} · ${s.steps.length} ${L.steps}${replay})_`);
    if (s.reason) out.push(`> ${line(s.reason)}`);
    const errs = [...s.failedRequests, ...s.consoleErrors].slice(0, 3);
    if (errs.length) out.push("", ...fence(errs.join("\n")));
    out.push("");
  }
  if (r.plan.skipped.length) out.push(`_${L.notRun}: ${line(r.plan.skipped.map((s) => s.title).join("; "))}_`, "");
  out.push("</details>");

  if (r.generatedTests) {
    const n = r.generatedTests.scenarioIds.length;
    out.push(
      "",
      `<details><summary>🧪 ${L.tests(n)} — <code>${r.generatedTests.fileName}</code></summary>`,
      "",
      ...fence(r.generatedTests.content.trimEnd(), "ts"),
      "</details>",
    );
  }

  if (r.warnings.length) out.push("", ...r.warnings.map((w) => `> ⚠️ ${line(w)}`));

  const cost = `${r.usage.priceKnown ? "" : "≤"}$${r.usage.costUsd.toFixed(2)}`;
  const evidence = links.artifactsUrl ? `📎 [${L.artifacts}](${links.artifactsUrl}) · ` : "";
  out.push("", `<sub>${evidence}${cost} · ${Math.round(r.durationMs / 1000)}s · ${r.usage.model} · ${L.tested} ${line(r.baseUrl, 200)}</sub>`);
  return out.join("\n");
}
