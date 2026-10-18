/**
 * Host-neutral issue-tracker surface for native agents. Jira Cloud is the
 * first implementation (./jira.ts). The control plane holds the credential;
 * no method takes a token. See docs/private/2026-09-30-jira-issue-tracker-design.md.
 */
export type IssueTrackerProvider = "jira";
export const ISSUE_TRACKER_PROVIDERS: readonly IssueTrackerProvider[] = ["jira"];
/** The product name shown to people (e.g. in a pull request's "Resolves Jira issue …" line). */
export const ISSUE_TRACKER_NAMES: Readonly<Record<IssueTrackerProvider, string>> = { jira: "Jira" };

export interface IssuePerson {
  accountId: string;
  displayName: string;
}

export interface IssueCommentView {
  id: string;
  author: IssuePerson | null;
  created: string;
  body: string;
  /** Written by the bot and carrying this agent's footer: editable with jira_edit_own_comment. */
  byThisAgent: boolean;
}

export interface IssueView {
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  status: string;
  /** The status's category (Jira statusCategory.key): "done" is what dedupe treats as resolved. */
  statusCategory: IssueStatusCategory;
  issueType: string;
  priority: string | null;
  labels: string[];
  assignee: IssuePerson | null;
  reporter: IssuePerson | null;
  url: string;
  /** Most recent last; capped. */
  comments: IssueCommentView[];
  commentsTruncated: boolean;
  /** Capped list; contents are read with readAttachmentText. Filenames are untrusted. */
  attachments: IssueAttachmentView[];
  /** Issue links (e.g. "relates to PROJ-9"), capped. Summaries are untrusted issue text. */
  links: IssueLinkView[];
}

export interface IssueLinkView {
  /** How this issue relates to the other, as Jira words it from this side ("relates to", "is blocked by"). */
  relation: string;
  key: string;
  summary: string;
  status: string;
}

export type IssueStatusCategory = "new" | "indeterminate" | "done";

export interface IssueAttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface CreateIssueInput {
  projectKey: string;
  /** Issue type name (case-insensitive); resolved to an id from the project's create metadata. */
  issueType: string;
  summary: string;
  descriptionMarkdown: string;
  labels?: string[];
  /** Priority name. */
  priority?: string;
  /** Component names. */
  components?: string[];
  parentKey?: string;
  /** customfield_N -> raw JSON value. */
  customFields?: Record<string, unknown>;
  /** Issue properties, set in the create call itself. */
  properties?: Record<string, unknown>;
  /** Projects whose bare issue keys in the description become smart links. */
  issueKeyProjects?: readonly string[];
}

export interface CreateMetaIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface CreateMetaField {
  fieldId: string;
  name: string;
  required: boolean;
  hasDefault: boolean;
  allowedValues?: string[];
}

export interface IssueSearchHit {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  updated: string;
  url: string;
}
export interface IssueSearchResult {
  issues: IssueSearchHit[];
  truncated: boolean;
}

/** Who the tracker credential acts as (Jira: GET /myself). */
export interface IssueTrackerIdentity {
  accountId: string;
  displayName: string;
  accountType: string;
}

/**
 * Bounds one tracker call for callers on a latency budget (e.g. inside a database transaction).
 * `timeoutMs` caps the WHOLE call, every request it makes included; with `retryOn429: false` a 429 fails
 * at once instead of sleeping for Retry-After, so the call cannot outlive `timeoutMs`.
 */
export interface TrackerCallOptions {
  timeoutMs?: number;
  retryOn429?: boolean;
}

/** What cost attribution keeps about an issue (src/core/attribution.ts): the hierarchy as of now. */
export interface IssueSnapshot {
  /** The key that was asked for (WorkItem.key). */
  key: string;
  title?: string;
  type?: string;
  url: string;
  /** The project (Jira) / team (Linear) the issue is in now. */
  scopeKey: string;
  parent?: { key: string; title?: string; kind: string };
}

export interface IssueTracker {
  readonly provider: IssueTrackerProvider;
  /** The bot's own accountId (cached after the first call). */
  botAccountId(): Promise<string>;
  /** The account the credential acts as, from the same cached call as botAccountId. */
  identity(): Promise<IssueTrackerIdentity>;
  getIssue(key: string, opts: { maxComments: number; agentMarker: string } & TrackerCallOptions): Promise<IssueView>;
  /** The project the issue is in now; an old key (kept as an alias after a move) resolves to its new project. */
  issueProject(key: string): Promise<string>;
  /** Title, type, scope and parent of `key` in one call, for cost attribution. Throws IssueTrackerError. */
  snapshotIssue(key: string, opts?: { timeoutMs?: number; retryOn429?: boolean }): Promise<IssueSnapshot>;
  search(jql: string, opts: { maxResults: number }): Promise<IssueSearchResult>;
  /** Whether issue `key` matches `jql` (used for a link's jqlFilter). Callers on a latency budget pass a short timeout and no 429 retry. */
  matchesJql(key: string, jql: string, opts?: TrackerCallOptions): Promise<boolean>;
  comment(
    key: string,
    /** issueKeyProjects: projects whose bare issue keys in the text become smart links. */
    input: { markdown: string; visibilityRole?: string; issueKeyProjects?: readonly string[] },
    opts?: TrackerCallOptions,
  ): Promise<{ id: string; url: string }>;
  editComment(
    key: string,
    commentId: string,
    input: { markdown: string; issueKeyProjects?: readonly string[] },
  ): Promise<void>;
  /** The comment's author accountId and plain text (uncapped: only for ownership checks, never shown to a model), or null when it doesn't exist. */
  readComment(key: string, commentId: string): Promise<{ authorId: string | null; body: string } | null>;
  issueUrl(key: string): string;
  /** Transitions the service account can perform now: target status name + category. */
  transitions(key: string): Promise<Array<{ id: string; name: string; toStatus: string; toCategory: string }>>;
  /** Performs the transition whose target status name matches (case-insensitive). */
  transitionTo(key: string, toStatus: string): Promise<{ transitionId: string; toStatus: string }>;
  /** Field ids the service account may edit on this issue (from editmeta). */
  editableFields(key: string): Promise<string[]>;
  /** Sets fields: labels (string[]), components (names), priority (name), customfield_N (raw JSON value). */
  editFields(key: string, fields: Record<string, unknown>): Promise<void>;
  linkTypes(opts?: TrackerCallOptions): Promise<Array<{ name: string; inward: string; outward: string }>>;
  linkIssues(input: { type: string; inwardKey: string; outwardKey: string }, opts?: TrackerCallOptions): Promise<void>;
  /** Adds (or, for an existing globalId, updates) a web link on the issue: Jira's remote link, shown under "Web links". */
  addRemoteLink(
    key: string,
    input: { globalId: string; url: string; title: string; status?: { resolved: boolean } },
  ): Promise<void>;
  /** The property's JSON value, or null when it does not exist. */
  getProperty(key: string, property: string): Promise<unknown>;
  setProperty(key: string, property: string, value: unknown): Promise<void>;
  /** Issue types creatable in the project by the service account. */
  createMeta(projectKey: string): Promise<{ issueTypes: CreateMetaIssueType[] }>;
  /** Create-screen fields for one issue type (by id). */
  fieldMeta(projectKey: string, issueTypeId: string): Promise<CreateMetaField[]>;
  /** Creates an issue; missing required fields (without defaults) fail with tracker_invalid_request naming them. */
  createIssue(input: CreateIssueInput, opts?: TrackerCallOptions): Promise<{ key: string; url: string }>;
  /** First `maxBytes` of a text-like attachment, decoded as UTF-8; other types fail with tracker_invalid_request. */
  readAttachmentText(
    id: string,
    maxBytes: number,
  ): Promise<{ filename: string; mimeType: string; text: string; truncated: boolean }>;
}

export type IssueTrackerErrorCode =
  | "tracker_not_found"
  | "tracker_permission_denied"
  | "tracker_rate_limited"
  | "tracker_invalid_request"
  | "tracker_api_error"
  | "tracker_invalid_response";

export class IssueTrackerError extends Error {
  constructor(
    readonly code: IssueTrackerErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "IssueTrackerError";
  }
}

export type IssueTrackerRegistry = Partial<Record<IssueTrackerProvider, IssueTracker>>;

export type IssueEventKind = "created" | "transitioned" | "labeled" | "assigned" | "mention";

/** What a webhook adapter (jira-events.ts) normalises a payload into, for src/core/issue-events.ts. */
export interface IssueEvent {
  provider: IssueTrackerProvider;
  projectKey: string;
  issueKey: string;
  /** Every kind this one delivery represents (an update can transition AND label). */
  kinds: IssueEventKind[];
  actor: { accountId: string; displayName: string };
  /** The new status name, with "transitioned". */
  toStatus?: string;
  /** Labels added by this change, with "labeled". */
  addedLabels: string[];
  /** The new assignee's accountId, with "assigned". */
  assigneeAccountId?: string;
  /** The mentioning comment, with "mention". */
  comment?: { id: string; body: string };
  /** Untrusted: whoever wrote them was not gated. Absent when the payload lacked the issue. */
  subject?: { summary: string; description: string };
}

/** Shared by the ingress and the tools: a Jira issue key, e.g. PROJ-123. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,9}$/;
/** A GitHub issue's recorded key (githubIssueKey): "<owner>/<repo>#<number>", the repository normalised to lowercase. */
export const GITHUB_ISSUE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}#[1-9]\d{0,9}$/;
/** The product name of each system an issue can be recorded from (CodingRun / IssuePullRequest issueProvider). */
export const ISSUE_SOURCE_NAMES: Readonly<Record<string, string>> = { ...ISSUE_TRACKER_NAMES, github: "GitHub" };

/**
 * A recorded issue (CodingRun / IssuePullRequest issueProvider + issueKey) as
 * people see it: the key re-validated for its provider, the system's name and
 * the issue's page. A GitHub issue's page comes from its key; a tracker
 * issue's from `trackerUrl` (the tracker's issueUrl), dropped when it throws
 * or is not https. Undefined for an unknown provider or a malformed key.
 */
export function issueReference(
  provider: string,
  key: string,
  trackerUrl?: (key: string) => string | undefined,
): { key: string; url?: string; trackerName: string } | undefined {
  let url: string | undefined;
  if (provider === "github") {
    if (!GITHUB_ISSUE_KEY.test(key)) return undefined;
    const hash = key.lastIndexOf("#");
    url = `https://github.com/${key.slice(0, hash)}/issues/${key.slice(hash + 1)}`;
  } else if (provider === "jira") {
    if (!ISSUE_KEY.test(key)) return undefined;
    try {
      url = trackerUrl?.(key);
    } catch {
      url = undefined;
    }
  } else {
    return undefined;
  }
  return { key, ...(url?.startsWith("https://") ? { url } : {}), trackerName: ISSUE_SOURCE_NAMES[provider] };
}
/** A Jira project key. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,254}$/;
/** An issue key's project: a Jira key's project key ("PROJ-123" → "PROJ"); a GitHub issue key's repository ("owner/repo#5" → "owner/repo"). */
export const projectOf = (issueKey: string): string => {
  const hash = issueKey.lastIndexOf("#");
  return issueKey.slice(0, hash >= 0 ? hash : issueKey.lastIndexOf("-"));
};
