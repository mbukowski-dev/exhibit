/**
 * Credentials never reach the model. The agent types placeholders such as
 * {{username}}; the executor substitutes real values in the browser and
 * redacts them from anything sent back to the model or written to reports.
 */
export class Secrets {
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string | undefined> = {}) {
    this.values = new Map(Object.entries(values).filter((e): e is [string, string] => Boolean(e[1])));
  }

  get names(): string[] {
    return [...this.values.keys()];
  }

  /** "{{password}}" → real value. Unknown placeholders are left as typed. */
  substitute(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => this.values.get(name) ?? m);
  }

  /** Placeholders in `text` that have no value, e.g. ["username"]. */
  unknownPlaceholders(text: string): string[] {
    return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).filter((n) => !this.values.has(n));
  }

  /** Real values → "{{name}}" (longest first so overlapping values redact cleanly). */
  redact(text: string): string {
    const entries = [...this.values.entries()].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length);
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`{{${name}}}`);
    return out;
  }
}
