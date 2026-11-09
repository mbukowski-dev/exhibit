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
  if (!/^https?:\/\//i.test(env.JIRA_BASE_URL!)) {
    throw new Error(
      `JIRA_BASE_URL must start with https:// (got "${env.JIRA_BASE_URL}"), e.g. https://your-company.atlassian.net`,
    );
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

/** serverInfo answers without login on every Jira Cloud site, so a 404 there means a wrong address. */
async function isJiraSite(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    return (await fetchImpl(`${baseUrl}/rest/api/3/serverInfo`, { headers: { Accept: "application/json" } })).ok;
  } catch {
    return false;
  }
}

function networkReason(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e));
}

export async function fetchJiraTicket(
  key: string,
  creds: JiraCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<Ticket> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

  let res: Response;
  try {
    res = await fetchImpl(
      `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?expand=names&fields=*all`,
      { headers },
    );
  } catch (e) {
    throw new Error(`Could not reach Jira at ${creds.baseUrl} (${networkReason(e)}). Check JIRA_BASE_URL and your connection.`);
  }

  // Jira Cloud answers a wrong e-mail or token on an issue URL with 404, not 401, so a bad token
  // would look like a missing ticket. This header is how Jira marks a failed login.
  const loginFailed = /AUTHENTICAT\w*_(FAILED|DENIED)/i.test(res.headers.get("x-seraph-loginreason") ?? "");
  if (loginFailed || res.status === 401 || res.status === 403) {
    throw new Error(
      "Jira rejected the credentials. Check JIRA_EMAIL and JIRA_API_TOKEN (the token may have expired or been revoked).",
    );
  }
  if (res.status === 404) {
    if (!(await isJiraSite(creds.baseUrl, fetchImpl))) {
      throw new Error(`No Jira site at ${creds.baseUrl}. Check JIRA_BASE_URL, e.g. https://your-company.atlassian.net`);
    }
    const hint = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(key) ? "" : " Ticket keys look like PROJ-123.";
    throw new Error(`Jira ticket ${key} not found, or this account cannot see it.${hint}`);
  }
  if (!res.ok) throw new Error(`Jira API error ${res.status}: ${(await res.text()).slice(0, 300)}`);

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
    summary: (f.summary ?? "").trim(), // a pasted title can keep a trailing newline
    type: f.issuetype?.name ?? "",
    status: f.status?.name ?? "",
    description: adfToText(f.description),
    comments,
    acceptanceField,
  };
}
