import type { Page } from "playwright";

export interface SeenDialog {
  /** alert | confirm | prompt | beforeunload */
  type: string;
  message: string;
}

/**
 * Accepts every browser dialog (alert, confirm, prompt) the way a tester
 * clicking "OK" would, and remembers what it said.
 *
 * Playwright dismisses a dialog nobody handles, so "Delete" → confirm()
 * is silently cancelled: nothing is deleted and a working app looks broken
 * (a false ❌). Returns a function that hands over the dialogs seen since
 * the last call.
 */
export function acceptDialogs(page: Page, redact: (s: string) => string = (s) => s): () => SeenDialog[] {
  const seen: SeenDialog[] = [];
  page.on("dialog", (d) => {
    seen.push({ type: d.type(), message: redact(d.message()).slice(0, 300) });
    d.accept().catch(() => {});
  });
  return () => seen.splice(0);
}

/** One line for the agent's step history; the text comes from the page, so it is quoted as data. */
export const describeDialogs = (dialogs: SeenDialog[]) =>
  dialogs.map((d) => `${d.type} dialog ${JSON.stringify(d.message)} was accepted`).join("; ");
