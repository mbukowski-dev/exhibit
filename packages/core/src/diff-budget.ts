/**
 * E11-3: fit a unified diff into a character budget without silently losing
 * files. Before: the diff was cut at 120k chars, so in a big PR the files
 * after the cut disappeared entirely — often the ones that mattered.
 *
 * - files are ranked: source related to the acceptance criteria first, then
 *   other source, tests, docs/config last;
 * - each file gets at most `perFileChars`, cut at a hunk boundary;
 * - included files keep their original order; omitted ones are listed.
 */
export interface DiffBudgetResult {
  diff: string;
  truncated: boolean;
  /** Files whose diff was shortened. */
  shortened: string[];
  /** Files left out completely. */
  omitted: string[];
}

export interface DiffBudgetOptions {
  maxChars?: number;
  perFileChars?: number;
  /** Text of the acceptance criteria (and ticket summary) for relevance. */
  relevanceText?: string;
}

interface Section {
  path: string;
  text: string;
  index: number;
  rank: number;
  score: number;
}

const STOPWORDS = new Set(
  "the and for with that this from when then into have will should must page user users shows show visible after before about there their which while".split(" "),
);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9ąćęłńóśźż]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

const isTest = (p: string) => /(^|\/)(__tests__|tests?|e2e|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p);
const isDocOrConfig = (p: string) =>
  /\.(md|mdx|txt|rst|ya?ml|json|toml|ini|lock)$/i.test(p) || /(^|\/)(docs?|\.github)\//i.test(p);

/** 0 = most important. */
function rankOf(path: string, score: number): number {
  if (isTest(path)) return 2;
  if (isDocOrConfig(path)) return 3;
  return score > 0 ? 0 : 1;
}

function splitSections(diff: string): Section[] {
  const parts = diff.split(/(?=^diff --git )/m).filter((p) => p.trim());
  return parts.map((text, index) => {
    const path = text.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2] ?? `(unknown ${index})`;
    return { path, text, index, rank: 1, score: 0 };
  });
}

/** Keeps the file header and whole hunks up to `max` characters. */
function shorten(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const hunks = text.split(/(?=^@@ )/m);
  let out = hunks[0] ?? "";
  let kept = 0;
  for (const h of hunks.slice(1)) {
    if (out.length + h.length > max) break;
    out += h;
    kept++;
  }
  if (kept === 0) out = text.slice(0, max); // a single giant hunk
  const omittedLines = text.slice(out.length).split("\n").length;
  return { text: out.trimEnd() + `\n… [${omittedLines} more lines of this file omitted]\n`, cut: true };
}

export function budgetDiff(diff: string, opts: DiffBudgetOptions = {}): DiffBudgetResult {
  const maxChars = opts.maxChars ?? 120_000;
  const perFile = opts.perFileChars ?? 20_000;
  if (diff.length <= maxChars) return { diff, truncated: false, shortened: [], omitted: [] };

  const words = keywords(opts.relevanceText ?? "");
  const sections = splitSections(diff);
  for (const s of sections) {
    const hay = (s.path + "\n" + s.text).toLowerCase();
    s.score = [...words].filter((w) => hay.includes(w)).length;
    s.rank = rankOf(s.path, s.score);
  }

  const order = [...sections].sort((a, b) => a.rank - b.rank || b.score - a.score || a.text.length - b.text.length);
  const chosen = new Map<number, string>();
  const shortened: string[] = [];
  const omitted: string[] = [];
  const reserve = 2_000; // room for the omitted-files note
  let used = 0;

  for (const s of order) {
    const room = maxChars - reserve - used;
    // A few hundred characters of a big file only mislead the model: include
    // a file whole or with a useful chunk, otherwise list it as omitted.
    if (room < Math.min(s.text.length, 2_000)) {
      omitted.push(s.path);
      continue;
    }
    const { text, cut } = shorten(s.text, Math.min(perFile, room));
    chosen.set(s.index, text);
    used += text.length;
    if (cut) shortened.push(s.path);
  }

  let out = sections.filter((s) => chosen.has(s.index)).map((s) => chosen.get(s.index)!).join("");
  if (omitted.length) {
    const list = omitted.slice(0, 50).join(", ") + (omitted.length > 50 ? `, … (${omitted.length - 50} more)` : "");
    out += `\n… [${omitted.length} lower-priority files omitted to fit the budget: ${list}]\n`;
  }
  return { diff: out, truncated: true, shortened, omitted };
}
