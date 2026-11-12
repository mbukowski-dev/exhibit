/**
 * E13-9: the team chooses the language Exhibit writes in.
 * `language: auto` (default) follows the ticket; any language name or code
 * (`pl`, `Polish`, `Deutsch`) fixes it for the whole report.
 */

/** Common codes → the name the model is told. Anything else is passed on as written. */
const NAMES: Record<string, string> = {
  en: "English", pl: "Polish", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese",
  nl: "Dutch", cs: "Czech", sk: "Slovak", uk: "Ukrainian", sv: "Swedish", da: "Danish", no: "Norwegian",
  fi: "Finnish", ro: "Romanian", hu: "Hungarian", tr: "Turkish", ja: "Japanese", ko: "Korean", zh: "Chinese",
};

/** The value ends up in a prompt, so it may only be a short word or two: letters, spaces, hyphens. */
export const LANGUAGE_PATTERN = /^\p{L}[\p{L} -]{0,39}$/u;

/** The language to write in, or undefined when it should follow the ticket. */
export function languageName(setting: string | undefined): string | undefined {
  const value = setting?.trim();
  if (!value || value.toLowerCase() === "auto") return undefined;
  return NAMES[value.toLowerCase()] ?? value;
}

/**
 * The sentence for a system prompt. `source` is what the model has in front of
 * it: the ticket (review, plan) or the scenario (browser agent).
 */
export function languageRule(setting: string | undefined, source: "ticket" | "scenario"): string {
  const name = languageName(setting);
  const write = name ? `Write in ${name}, whatever language the ${source} is in.` : `Write in the language of the ${source}.`;
  // Checks compare against the exact text on the page, so a translated quote would never match.
  return `${write} Quote text from the application and the ticket exactly as written; never translate a quote.`;
}

/** Fixed words of the report. Built in for English and Polish; other languages use English for now. */
export interface Labels {
  pass: string;
  fail: string;
  needs_review: string;
  verified: (passed: number, total: number, partial: number) => string;
  criterion: string;
  evidence: string;
  review: string;
  coverage: Record<"covered" | "partial" | "missing" | "unclear", string>;
  risks: string;
  scenarios: string;
  regression: string;
  steps: string;
  unblock: string;
  notRun: string;
  tests: (n: number) => string;
  artifacts: string;
  tested: string;
  changed: (author: string, date: string) => string;
  /** The judge's own sentences in the "Evidence" column. */
  judge: {
    notVerified: string;
    mayPredate: string;
    notInChange: string;
    browser: string;
    code: string;
    noScenario: string;
  };
}

const EN: Labels = {
  pass: "✅ All acceptance criteria verified",
  fail: "❌ Acceptance criteria not met",
  needs_review: "⚠️ Needs human review",
  verified: (p, t, partial) => `${p}/${t} acceptance criteria verified${partial ? `, ${partial} partly` : ""}`,
  criterion: "Acceptance criterion",
  evidence: "Evidence",
  review: "Code review against the ticket",
  coverage: { covered: "✅ covered", partial: "🟡 partial", missing: "❌ missing", unclear: "❔ unclear" },
  risks: "Risk areas",
  scenarios: "Scenarios",
  regression: "regression",
  steps: "steps",
  unblock: "To get the blocked scenarios checked",
  notRun: "Not run (limit `max_scenarios`)",
  tests: (n) => `${n} generated Playwright test${n > 1 ? "s" : ""}`,
  artifacts: "Videos & traces",
  tested: "tested",
  changed: (author, date) => `changed in a ticket comment by ${author} (${date})`,
  judge: {
    notVerified: "Not verified:",
    mayPredate: "(Note: code review found no implementation in the diff — it may predate this PR.)",
    notInChange: "Not in this change and could not be verified in the browser. Code review:",
    browser: "Browser:",
    code: "Code:",
    noScenario: "No scenario covered this criterion.",
  },
};

const PL: Labels = {
  pass: "✅ Wszystkie kryteria akceptacji sprawdzone",
  fail: "❌ Kryteria akceptacji niespełnione",
  needs_review: "⚠️ Wymaga sprawdzenia przez człowieka",
  verified: (p, t, partial) => `sprawdzone kryteria akceptacji: ${p}/${t}${partial ? `, częściowo: ${partial}` : ""}`,
  criterion: "Kryterium akceptacji",
  evidence: "Dowód",
  review: "Review kodu względem ticketu",
  coverage: { covered: "✅ pokryte", partial: "🟡 częściowo", missing: "❌ brak", unclear: "❔ niejasne" },
  risks: "Obszary ryzyka",
  scenarios: "Scenariusze",
  regression: "regresja",
  steps: "kroków",
  unblock: "Co odblokuje zablokowane scenariusze",
  notRun: "Nie uruchomiono (limit `max_scenarios`)",
  tests: (n) => `Wygenerowane testy Playwright: ${n}`,
  artifacts: "Nagrania i ślady",
  tested: "testowano",
  changed: (author, date) => `zmienione w komentarzu do ticketu przez ${author} (${date})`,
  judge: {
    notVerified: "Niesprawdzone:",
    mayPredate: "(Uwaga: review kodu nie znalazło implementacji w tym diffie — mogła powstać przed tym PR.)",
    notInChange: "Nie ma tego w tej zmianie i nie udało się sprawdzić w przeglądarce. Review kodu:",
    browser: "Przeglądarka:",
    code: "Kod:",
    noScenario: "Żaden scenariusz nie objął tego kryterium.",
  },
};

const POLISH = new Set(["pl", "polish", "polski"]);

export function labelsFor(setting: string | undefined): Labels {
  return POLISH.has((setting ?? "").trim().toLowerCase()) ? PL : EN;
}
