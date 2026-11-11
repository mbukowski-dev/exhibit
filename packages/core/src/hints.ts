import type { ScenarioResult } from "./browser/agent.js";
import type { ExhibitConfig } from "./config.js";
import type { Scenario } from "./plan.js";

/**
 * E13-2: a blocked scenario is a dead end unless the report says what would
 * unblock it. These suggestions are picked from what happened in the run
 * (never from the model's wording, which can be in any language) and name the
 * exact setting to change.
 */
export interface Hint {
  kind: "add_auth" | "check_login" | "shortcut" | "label" | "expected_wording" | "needs_link" | "unreachable" | "notes";
  /** Markdown written by Exhibit; nothing from the model, the page or the ticket goes in unchecked. */
  text: string;
  /** Config to paste into .exhibit.yml. */
  snippet?: string;
}

/** A role name comes from the planner (a model). Only a plain word may reach the text or the YAML snippet. */
const safeRole = (role: string | undefined) => (role && /^[A-Za-z0-9_-]{1,30}$/.test(role) && role !== "anonymous" ? role : "user");

const authSnippet = (role: string) => `auth:\n  - role: ${role}\n    username_env: EXHIBIT_USERNAME\n    password_env: EXHIBIT_PASSWORD`;

const SECRETS_NOTE = "The values come from GitHub secrets (pass them to the action under `env:`), never from the file:";

export function blockedHint(r: ScenarioResult, scenario: Scenario | undefined, config: Pick<ExhibitConfig, "auth">): Hint | undefined {
  if (r.verdict !== "blocked") return undefined;
  // Nothing in the configuration changes these: a human check, or a limit whose message already says what to raise.
  if (r.blocker === "not_testable" || r.blocker === "cost_limit") return undefined;

  const role = scenario?.role ?? "anonymous";
  const hasAuth = config.auth.length > 0;
  const reachedForCredentials = r.steps.some((s) => s.error?.startsWith("No secret named"));

  if (r.blocker === "login_failed" || (hasAuth && r.endedOnLoginPage)) {
    return {
      kind: "check_login",
      text:
        "Signing in with the configured test account did not work. Check that the account exists on this environment and that the " +
        "secrets named in `username_env` / `password_env` reach the action (`env:` in the workflow). A `login_flow` script is more " +
        "reliable than letting the agent sign in by itself.",
    };
  }
  if (!hasAuth && (role !== "anonymous" || r.endedOnLoginPage || reachedForCredentials)) {
    const lead =
      role !== "anonymous"
        ? `This runs signed in as "${safeRole(role)}", but \`.exhibit.yml\` has no \`auth\` section.`
        : "The browser ran into a sign-in page, and `.exhibit.yml` has no `auth` section.";
    return { kind: "add_auth", text: `${lead} Add a test account. ${SECRETS_NOTE}`, snippet: authSnippet(safeRole(role)) };
  }

  switch (r.blocker) {
    case "step_limit":
      return {
        kind: "shortcut",
        text:
          `Not finished within ${r.steps.length} steps. If the way there is long, describe a shortcut in \`agent_notes\` ` +
          "(a direct URL, a record that already exists), or split the acceptance criterion into smaller ones.",
      };
    case "stuck":
      return {
        kind: "label",
        text:
          "The agent kept failing on the same element. Usually the element has no accessible name (a button without text, an input " +
          "without a label) or something covers it. Give it a label, or describe another way to the goal in `agent_notes`.",
      };
    case "unverified_pass":
      return {
        kind: "expected_wording",
        text:
          "The agent believed this works but could not point at the expected result on the page. If the app shows it in other words " +
          "or in another place, say so in the acceptance criterion or in `agent_notes`.",
      };
    case "guessed_url":
      return {
        kind: "needs_link",
        text:
          "This needs a link, token or ID the browser cannot get by itself. If your test environment has a way to get one " +
          "(a fixed test link, an admin page that lists them), describe it in `agent_notes`.",
      };
    case "run_error":
      return /net::ERR|Timeout \d+ms exceeded|ECONNREFUSED|ENOTFOUND/.test(r.reason)
        ? { kind: "unreachable", text: "The app did not respond. Check `preview_url` and that this pull request's deployment is up." }
        : undefined;
    default:
      return {
        kind: "notes",
        text:
          "If the agent lacked something that exists only on your environment (a test account, a record, a feature flag), " +
          "describe it in `agent_notes` in `.exhibit.yml`.",
      };
  }
}
