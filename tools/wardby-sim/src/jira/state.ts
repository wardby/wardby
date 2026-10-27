// TEST ONLY (wardby-sim). The simulated Jira Cloud site's state: one service account (the
// identity wardby's token belongs to), people, projects with a simplified workflow, issues with
// ADF descriptions and comments, remote links, issue properties and webhook subscriptions.
// Shapes follow Atlassian's REST v3 documentation (unverified against a recorded response).

/** The token wardby is given; the switch refuses any Jira token that does not start with `sim-`. */
export const SIM_JIRA_TOKEN = "sim-jira-service-account-token";
/** The service account the token belongs to (accountType "app", as Atlassian service accounts are). */
export const SIM_JIRA_BOT = "sim-jira-bot-0001";
/** A licensed person (accountType "atlassian") who files, assigns and comments. */
export const SIM_JIRA_DEV = "sim-jira-dev-0001";
export const SIM_JIRA_SITE = "https://sim-site.atlassian.net";

export interface JiraUser {
  accountId: string;
  displayName: string;
  /** "atlassian" (a licensed person), "app" (a service account or app), "customer" (JSM). */
  accountType: string;
  locale: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  /** new | indeterminate | done */
  category: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  statuses: JiraStatus[];
  /** Project roles a comment's visibility may name. */
  roles: string[];
}

export interface JiraComment {
  id: string;
  author: string;
  updateAuthor: string;
  /** ADF document, as REST v3 stores and returns it. */
  body: unknown;
  created: string;
  updated: string;
  visibility?: { type: string; value: string };
  /** Every earlier body, oldest first (an edit keeps the old one here). */
  history: unknown[];
}

export interface JiraRemoteLink {
  id: number;
  globalId: string;
  object: { url: string; title: string; status?: { resolved?: boolean } };
  /** Every write (create or update by globalId), in order. */
  writes: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: unknown;
  issueType: { id: string; name: string; hierarchyLevel: number; subtask: boolean };
  priority: string | null;
  labels: string[];
  assignee: string | null;
  reporter: string;
  statusId: string;
  parentKey?: string;
  created: string;
  updated: string;
  comments: JiraComment[];
  remoteLinks: JiraRemoteLink[];
  properties: Map<string, unknown>;
  links: { type: string; inwardKey: string; outwardKey: string }[];
  /** Status moves, in order (who, from, to). */
  transitions: { by: string; from: string; to: string }[];
}

export interface JiraSubscription {
  url: string;
  secret: string;
  /** Event names it takes ("jira:issue_updated", "comment_created", ...); empty = all. */
  events: string[];
  /** How comment and description bodies appear in payloads: "wiki" (a string) or "adf". */
  bodyFormat: "wiki" | "adf";
}

const DEFAULT_STATUSES: JiraStatus[] = [
  { id: "10000", name: "To Do", category: "new" },
  { id: "3", name: "In Progress", category: "indeterminate" },
  { id: "10001", name: "In Review", category: "indeterminate" },
  { id: "10002", name: "Done", category: "done" },
];

export const LINK_TYPES = [
  { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  { id: "10001", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
  { id: "10002", name: "Relates", inward: "relates to", outward: "relates to" },
];

export class JiraState {
  tokens = new Map<string, { accountId: string; revoked: boolean }>();
  users = new Map<string, JiraUser>();
  projects = new Map<string, JiraProject>();
  issues = new Map<string, JiraIssue>();
  subscriptions: JiraSubscription[] = [];
  private nextIssueId = 10_000;
  private nextCommentId = 20_000;
  private nextLinkId = 1;
  /** A fixed clock that ticks a second per write, so timestamps are deterministic. */
  private clock = Date.parse("2026-10-01T09:00:00.000Z");

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tokens = new Map([[SIM_JIRA_TOKEN, { accountId: SIM_JIRA_BOT, revoked: false }]]);
    this.users = new Map([
      [SIM_JIRA_BOT, { accountId: SIM_JIRA_BOT, displayName: "wardby (sim)", accountType: "app", locale: "en_US" }],
      [SIM_JIRA_DEV, { accountId: SIM_JIRA_DEV, displayName: "Dana Dev", accountType: "atlassian", locale: "en_US" }],
    ]);
    this.projects = new Map();
    this.issues = new Map();
    this.subscriptions = [];
    this.nextIssueId = 10_000;
    this.nextCommentId = 20_000;
    this.nextLinkId = 1;
    this.clock = Date.parse("2026-10-01T09:00:00.000Z");
  }

  /** Jira's timestamp form: 2026-10-01T09:00:01.000+0000. */
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace("Z", "+0000");
  }

  addProject(key: string, name = key): JiraProject {
    const project: JiraProject = {
      id: String(10_000 + this.projects.size),
      key,
      name,
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      roles: ["Developers", "Administrators"],
    };
    this.projects.set(key, project);
    return project;
  }

  addIssue(input: {
    projectKey: string;
    summary: string;
    description?: unknown;
    reporter?: string;
    labels?: string[];
    assignee?: string | null;
    priority?: string;
    issueType?: string;
    parentKey?: string;
  }): JiraIssue {
    const project = this.projects.get(input.projectKey) ?? this.addProject(input.projectKey);
    const number = [...this.issues.values()].filter((i) => i.projectKey === project.key).length + 1;
    const now = this.tick();
    const typeName = input.issueType ?? "Task";
    const issue: JiraIssue = {
      id: String(this.nextIssueId++),
      key: `${project.key}-${number}`,
      projectKey: project.key,
      summary: input.summary,
      description: input.description ?? null,
      issueType: {
        id: typeName.toLowerCase() === "epic" ? "10000" : "10001",
        name: typeName,
        hierarchyLevel: typeName.toLowerCase() === "epic" ? 1 : 0,
        subtask: false,
      },
      priority: input.priority ?? "Medium",
      labels: [...(input.labels ?? [])],
      assignee: input.assignee ?? null,
      reporter: input.reporter ?? SIM_JIRA_DEV,
      statusId: project.statuses[0].id,
      ...(input.parentKey ? { parentKey: input.parentKey } : {}),
      created: now,
      updated: now,
      comments: [],
      remoteLinks: [],
      properties: new Map(),
      links: [],
      transitions: [],
    };
    this.issues.set(issue.key, issue);
    return issue;
  }

  /** By key or numeric id, as Jira accepts either in a path. */
  issue(keyOrId: string): JiraIssue | undefined {
    return this.issues.get(keyOrId) ?? [...this.issues.values()].find((i) => i.id === keyOrId);
  }

  project(issue: JiraIssue): JiraProject {
    return this.projects.get(issue.projectKey)!;
  }

  status(issue: JiraIssue): JiraStatus {
    return this.project(issue).statuses.find((s) => s.id === issue.statusId)!;
  }

  addComment(
    issue: JiraIssue,
    author: string,
    body: unknown,
    visibility?: { type: string; value: string },
  ): JiraComment {
    const now = this.tick();
    const comment: JiraComment = {
      id: String(this.nextCommentId++),
      author,
      updateAuthor: author,
      body,
      created: now,
      updated: now,
      ...(visibility ? { visibility } : {}),
      history: [],
    };
    issue.comments.push(comment);
    issue.updated = now;
    return comment;
  }

  editComment(issue: JiraIssue, comment: JiraComment, editor: string, body: unknown): void {
    comment.history.push(comment.body);
    comment.body = body;
    comment.updateAuthor = editor;
    comment.updated = this.tick();
    issue.updated = comment.updated;
  }

  /** Creates the link, or updates the one with the same globalId (Jira's upsert). */
  upsertRemoteLink(
    issue: JiraIssue,
    globalId: string,
    object: JiraRemoteLink["object"],
  ): { link: JiraRemoteLink; created: boolean } {
    const existing = globalId ? issue.remoteLinks.find((l) => l.globalId === globalId) : undefined;
    if (existing) {
      existing.object = object;
      existing.writes += 1;
      return { link: existing, created: false };
    }
    const link: JiraRemoteLink = { id: this.nextLinkId++, globalId, object, writes: 1 };
    issue.remoteLinks.push(link);
    return { link, created: true };
  }

  /** Simplified workflow: every status can move to every other one; the transition is named after its target. */
  transitionsFor(issue: JiraIssue): { id: string; name: string; to: JiraStatus }[] {
    return this.project(issue)
      .statuses.map((to, index) => ({ id: String((index + 1) * 10 + 1), name: to.name, to }))
      .filter((t) => t.to.id !== issue.statusId);
  }

  moveTo(issue: JiraIssue, statusId: string, by: string): { from: JiraStatus; to: JiraStatus } {
    const from = this.status(issue);
    issue.statusId = statusId;
    issue.updated = this.tick();
    const to = this.status(issue);
    issue.transitions.push({ by, from: from.name, to: to.name });
    return { from, to };
  }
}

// --- ADF ---

const textOfAttr = (value: unknown): string => (typeof value === "string" ? value : "");

type AdfNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: unknown[] };

/** Whether `value` is an ADF document Jira would accept: { type: "doc", version: 1, content: [...] }. */
export function isAdfDoc(value: unknown): boolean {
  const doc = value as AdfNode & { version?: unknown };
  return !!doc && typeof doc === "object" && doc.type === "doc" && doc.version === 1 && Array.isArray(doc.content);
}

/** Plain text of an ADF document (mentions as their text, links' hrefs in brackets), for assertions. */
export function adfText(node: unknown): string {
  if (typeof node === "string") return node;
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const n = value as AdfNode & { marks?: { type?: string; attrs?: { href?: string } }[] };
    if (n.type === "text" && typeof n.text === "string") {
      parts.push(n.text);
      const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
      if (href && href !== n.text) parts.push(` <${href}>`);
    } else if (n.type === "mention") parts.push(textOfAttr(n.attrs?.text) || `@${textOfAttr(n.attrs?.id)}`);
    else if (n.type === "inlineCard" || n.type === "blockCard") parts.push(textOfAttr(n.attrs?.url));
    else if (n.type === "hardBreak") parts.push("\n");
    for (const child of n.content ?? []) walk(child);
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem" || n.type === "codeBlock")
      parts.push("\n");
  };
  walk(node);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The account ids mentioned in an ADF document. */
export function adfMentions(node: unknown): string[] {
  const ids: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const n = value as AdfNode;
    if (n.type === "mention" && typeof n.attrs?.id === "string") ids.push(n.attrs.id);
    for (const child of n.content ?? []) walk(child);
  };
  walk(node);
  return ids;
}

/** A one-paragraph ADF document from text, with `@<accountId>` written as a mention node. */
export function adfFromText(text: string, users: Map<string, JiraUser>): unknown {
  const content: unknown[] = [];
  for (const piece of text.split(/(@[A-Za-z0-9:_-]+)/)) {
    if (!piece) continue;
    const user = piece.startsWith("@") ? users.get(piece.slice(1)) : undefined;
    if (user) content.push({ type: "mention", attrs: { id: user.accountId, text: `@${user.displayName}` } });
    else content.push({ type: "text", text: piece });
  }
  return { type: "doc", version: 1, content: [{ type: "paragraph", content }] };
}

/** The same text as wiki markup (how webhook payloads carry bodies): mentions as [~accountid:...]. */
export function wikiFromText(text: string, users: Map<string, JiraUser>): string {
  return text.replace(/@([A-Za-z0-9:_-]+)/g, (whole, id: string) => (users.has(id) ? `[~accountid:${id}]` : whole));
}

/** An ADF document as wiki markup, for webhook payloads: text, mentions and links only. */
export function adfToWiki(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node) return "";
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const n = value as AdfNode;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    else if (n.type === "mention" && typeof n.attrs?.id === "string") out.push(`[~accountid:${n.attrs.id}]`);
    else if (n.type === "inlineCard") out.push(textOfAttr(n.attrs?.url));
    else if (n.type === "hardBreak") out.push("\n");
    for (const child of n.content ?? []) walk(child);
    if (n.type === "paragraph") out.push("\n");
  };
  walk(node);
  return out.join("").trim();
}
