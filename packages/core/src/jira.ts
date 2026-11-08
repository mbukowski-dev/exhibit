export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface TicketComment {
  author: string;
  created: string;
  body: string;
}

export interface Ticket {
  key: string;
  url: string;
  summary: string;
  type: string;
  status: string;
  description: string;
  comments: TicketComment[];
  /** Raw text of a dedicated "Acceptance Criteria" custom field, if any. */
  acceptanceField?: string;
}

export function jiraCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JiraCredentials {
  const missing = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(`Missing Jira credentials: ${missing.join(", ")}`);
  }
  return {
    baseUrl: env.JIRA_BASE_URL!.replace(/\/+$/, ""),
    email: env.JIRA_EMAIL!,
    apiToken: env.JIRA_API_TOKEN!,
  };
}

// ---------- Atlassian Document Format → plain text ----------

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return render(node as AdfNode, "").replace(/\n{3,}/g, "\n\n").trim();
}

function render(node: AdfNode, indent: string): string {
  const kids = (sep = "", ind = indent) =>
    (node.content ?? []).map((c) => render(c, ind)).join(sep);

  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return String(node.attrs?.text ?? "@user");
    case "emoji":
      return String(node.attrs?.text ?? "");
    case "inlineCard":
      return String(node.attrs?.url ?? "");
    case "paragraph":
      return kids() + "\n\n";
    case "heading": {
      const level = Number(node.attrs?.level ?? 2);
      return "#".repeat(level) + " " + kids() + "\n\n";
    }
    case "bulletList":
      return (node.content ?? []).map((li) => indent + "- " + renderItem(li, indent)).join("") + "\n";
    case "orderedList":
      return (node.content ?? []).map((li, i) => `${indent}${i + 1}. ${renderItem(li, indent)}`).join("") + "\n";
    case "taskList":
      return (node.content ?? []).map((li) => indent + "- [ ] " + renderItem(li, indent)).join("") + "\n";
    case "codeBlock":
      return "```\n" + kids() + "\n```\n\n";
    case "rule":
      return "---\n\n";
    case "table":
      return kids() + "\n";
    case "tableRow":
      return "| " + (node.content ?? []).map((c) => render(c, "").replace(/\n+/g, " ").trim()).join(" | ") + " |\n";
    default:
      return kids();
  }
}

function renderItem(li: AdfNode, indent: string): string {
  const parts = (li.content ?? []).map((c) =>
    c.type === "bulletList" || c.type === "orderedList"
      ? "\n" + render(c, indent + "  ").trimEnd()
      : render(c, indent).trim(),
  );
  return parts.join(" ").trim() + "\n";
}

// ---------- API ----------

export async function fetchJiraTicket(
  key: string,
  creds: JiraCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<Ticket> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

  const res = await fetchImpl(
    `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?expand=names&fields=*all`,
    { headers },
  );
  if (res.status === 404) throw new Error(`Jira ticket ${key} not found (or no access)`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jira rejected the credentials (${res.status}). Check JIRA_EMAIL / JIRA_API_TOKEN.`);
  }
  if (!res.ok) throw new Error(`Jira API error ${res.status}: ${await res.text()}`);

  const issue = (await res.json()) as {
    key: string;
    names?: Record<string, string>;
    fields: Record<string, any>;
  };
  const f = issue.fields;

  // Many teams keep AC in a custom field — find it by its display name.
  let acceptanceField: string | undefined;
  for (const [id, name] of Object.entries(issue.names ?? {})) {
    if (/acceptance|kryteri/i.test(name) && f[id]) {
      acceptanceField = adfToText(f[id]);
      break;
    }
  }

  const comments: TicketComment[] = (f.comment?.comments ?? []).map((c: any) => ({
    author: c.author?.displayName ?? "unknown",
    created: c.created,
    body: adfToText(c.body),
  }));

  return {
    key: issue.key,
    url: `${creds.baseUrl}/browse/${issue.key}`,
    summary: f.summary ?? "",
    type: f.issuetype?.name ?? "",
    status: f.status?.name ?? "",
    description: adfToText(f.description),
    comments,
    acceptanceField,
  };
}
