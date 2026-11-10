/**
 * Jira Cloud implementation of IssueTracker over REST v3. Rich text is ADF
 * in and plain text out (adf.ts). The bot's comments carry a visible footer
 * naming the agent (ADF has no hidden comments), which is how
 * jira_edit_own_comment knows a comment is this agent's.
 */
import { cutUntrustedText } from "../../core/untrusted-content.js";
import { adfToText, markdownToAdf } from "./adf.js";
import type { JiraClient, RequestOptions } from "./jira-client.js";
import {
  IssueTrackerError,
  type CreateIssueInput,
  type CreateMetaField,
  type CreateMetaIssueType,
  type IssueAttachmentView,
  type IssueLinkView,
  projectOf,
  type IssueCommentView,
  type IssueStatusCategory,
  type IssuePerson,
  type IssueSearchResult,
  type IssueSnapshot,
  type IssueTracker,
  type IssueTrackerIdentity,
  type IssueView,
  type TrackerCallOptions,
} from "./types.js";

const ISSUE_FIELDS =
  "project,summary,description,status,issuetype,priority,labels,assignee,reporter,comment,attachment,issuelinks";
const MAX_LINKS = 20;
const MAX_COMMENT = 4_000;
/** An issue view lists (and jira_read_attachment can read) only the most recent this many attachments. */
const MAX_ATTACHMENTS = 20;
const META_PAGE_SIZE = 50;
const META_MAX_PAGES = 10;
/** Required fields wardby always supplies itself in a create call. */
const ALWAYS_SUPPLIED = new Set(["project", "issuetype"]);
const PERSONAL_ACCOUNT_MESSAGE =
  "wardby's Jira token belongs to a person's account; use a service account (see docs/jira-agents.md).";

export const agentFooter = (agentId: string): string => `_wardby agent ${agentId}_`;

/** Whether rendered comment text ends with this agent's footer (as adfToText renders it: no markdown underscores). */
export const hasAgentFooter = (text: string, agentId: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  return last.trim() === `wardby agent ${agentId}`;
};

/** Whether rendered comment text ends with wardby's run-status footer (`_wardby run <id>_` as adfToText renders it). */
export const isStatusComment = (text: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  return /^wardby run \S+$/.test(last.trim());
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const person = (v: unknown): IssuePerson | null => {
  const p = obj(v);
  return typeof p.accountId === "string" ? { accountId: p.accountId, displayName: str(p.displayName) } : null;
};

/**
 * One call's budget (TrackerCallOptions): each request gets what is left of `timeoutMs`, and awaits that
 * are not requests (the cached identity) are abandoned at the deadline. Without `timeoutMs`, a no-op.
 */
function callBudget(opts: TrackerCallOptions = {}) {
  const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  const timedOut = () => new IssueTrackerError("tracker_api_error", "The Jira call timed out.");
  const left = (): number | undefined => {
    if (deadline === undefined) return undefined;
    const ms = deadline - Date.now();
    if (ms <= 0) throw timedOut();
    return ms;
  };
  return {
    request(extra: RequestOptions = {}): RequestOptions {
      const ms = left();
      return {
        ...extra,
        ...(ms !== undefined ? { timeoutMs: ms } : {}),
        ...(opts.retryOn429 !== undefined ? { retryOn429: opts.retryOn429 } : {}),
      };
    },
    async within<T>(p: Promise<T>): Promise<T> {
      const ms = left();
      if (ms === undefined) return p;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timedOut()), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
type CallBudget = ReturnType<typeof callBudget>;

/** Jira reports locales as "en_US"; Accept-Language wants BCP-47 ("en-US"). Anything malformed keeps the default. */
function localeToLanguageTag(locale: unknown): string {
  if (typeof locale !== "string") return "en-US";
  const m = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2}|\d{3}))?$/.exec(locale.trim());
  return m ? (m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]) : "en-US";
}

const statusCategory = (v: unknown): IssueStatusCategory => {
  const key = str(obj(obj(v).statusCategory).key);
  return key === "new" || key === "done" ? key : "indeterminate";
};

const isTextMime = (mime: string): boolean => {
  const m = mime.split(";")[0].trim().toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/x-ndjson" ||
    m.endsWith("+json")
  );
};

export class JiraIssueTracker implements IssueTracker {
  readonly provider = "jira" as const;
  private me: Promise<IssueTrackerIdentity> | null = null;

  constructor(
    private readonly client: JiraClient,
    private readonly siteUrl: string,
    private readonly opts: { epicLinkField?: string } = {},
  ) {}

  identity(): Promise<IssueTrackerIdentity> {
    const pending = (this.me ??= this.client.request<Json>("GET", "/rest/api/3/myself").then((me) => {
      if (typeof me.accountId !== "string") throw new IssueTrackerError("tracker_invalid_response");
      this.client.setLanguage(localeToLanguageTag(me.locale));
      return { accountId: me.accountId, displayName: str(me.displayName), accountType: str(me.accountType) };
    }));
    pending.catch(() => {
      if (this.me === pending) this.me = null;
    });
    return pending;
  }

  /** Refuses to act when the token belongs to a person; a failed identity() propagates and is not cached. */
  private async ready(budget: CallBudget = callBudget()): Promise<void> {
    if ((await budget.within(this.identity())).accountType === "atlassian") {
      throw new IssueTrackerError("tracker_permission_denied", PERSONAL_ACCOUNT_MESSAGE);
    }
  }

  async botAccountId(): Promise<string> {
    return (await this.identity()).accountId;
  }

  /** Markdown to ADF, with this site's issue links (and the given projects' bare keys) as smart links. */
  private toAdf(markdown: string, issueKeyProjects?: readonly string[]) {
    return markdownToAdf(markdown, { siteUrl: this.siteUrl, projectKeys: issueKeyProjects ?? [] });
  }

  issueUrl(key: string): string {
    return `${this.siteUrl}/browse/${key}`;
  }

  async getIssue(
    key: string,
    opts: { maxComments: number; agentMarker: string } & TrackerCallOptions,
  ): Promise<IssueView> {
    const budget = callBudget(opts);
    await this.ready(budget);
    const [raw, bot] = await Promise.all([
      this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`, undefined, budget.request()),
      budget.within(this.botAccountId()),
    ]);
    const f = obj(raw.fields);
    const commentBlock = obj(f.comment);
    const all = Array.isArray(commentBlock.comments) ? commentBlock.comments.map(obj) : [];
    // wardby's own status comments ("Working on it" / outcome) are not issue context and mislead agents; drop
    // them (bot-authored only) before windowing so they do not crowd out real comments.
    // maxComments 0 (e.g. dedupe's status check): convert no comment at all (slice(-0) would keep them all).
    const wantComments = opts.maxComments > 0;
    const visible = wantComments
      ? all.filter((c) => !(person(c.author)?.accountId === bot && isStatusComment(adfToText(c.body, Infinity))))
      : all;
    const recent = wantComments ? visible.slice(-opts.maxComments) : [];
    const comments: IssueCommentView[] = recent.map((c) => {
      const author = person(c.author);
      const full = adfToText(c.body, Infinity);
      const body = adfToText(c.body, MAX_COMMENT);
      return {
        id: str(c.id),
        author,
        created: str(c.created),
        body,
        byThisAgent: author?.accountId === bot && hasAgentFooter(full, opts.agentMarker),
      };
    });
    const total = typeof commentBlock.total === "number" ? commentBlock.total : all.length;
    const description = cutUntrustedText(adfToText(f.description, Infinity));
    return {
      key: str(raw.key),
      projectKey: str(obj(f.project).key),
      summary: str(f.summary),
      description: description.text,
      descriptionTruncated: description.cut,
      status: str(obj(f.status).name),
      statusCategory: statusCategory(f.status),
      issueType: str(obj(f.issuetype).name),
      priority: str(obj(f.priority).name) || null,
      labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
      assignee: person(f.assignee),
      reporter: person(f.reporter),
      url: this.issueUrl(str(raw.key)),
      comments,
      // True when non-status comments were omitted (the window cut some, or Jira returned only part of them).
      commentsTruncated: visible.length > comments.length || total > all.length,
      attachments: (Array.isArray(f.attachment) ? f.attachment : [])
        .map(obj)
        .filter((a) => str(a.id) !== "")
        // Jira lists attachments oldest first; keep the most recent (a fresh log is usually the useful one).
        .slice(-MAX_ATTACHMENTS)
        .map((a): IssueAttachmentView => ({
          id: str(a.id),
          filename: str(a.filename),
          mimeType: str(a.mimeType),
          size: typeof a.size === "number" ? a.size : 0,
        })),
      links: (Array.isArray(f.issuelinks) ? f.issuelinks : [])
        .map(obj)
        .flatMap((l): IssueLinkView[] => {
          const type = obj(l.type);
          const [other, relation] = l.outwardIssue
            ? [obj(l.outwardIssue), str(type.outward)]
            : [obj(l.inwardIssue), str(type.inward)];
          const key = str(other.key);
          if (!key) return [];
          const of = obj(other.fields);
          return [
            { relation: relation || str(type.name), key, summary: str(of.summary), status: str(obj(of.status).name) },
          ];
        })
        .slice(0, MAX_LINKS),
    };
  }

  async issueProject(key: string): Promise<string> {
    await this.ready();
    const raw = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}?fields=project`);
    const projectKey = obj(obj(raw.fields).project).key;
    if (typeof projectKey !== "string" || !projectKey) throw new IssueTrackerError("tracker_invalid_response");
    return projectKey;
  }

  async snapshotIssue(key: string, opts: { timeoutMs?: number; retryOn429?: boolean } = {}): Promise<IssueSnapshot> {
    await this.ready();
    const fields = [
      "summary",
      "issuetype",
      "project",
      "parent",
      ...(this.opts.epicLinkField ? [this.opts.epicLinkField] : []),
    ];
    const raw = await this.client.request<Json>(
      "GET",
      `/rest/api/3/issue/${key}?fields=${fields.join(",")}`,
      undefined,
      { timeoutMs: opts.timeoutMs, retryOn429: opts.retryOn429 },
    );
    const f = obj(raw.fields);
    const parentRaw = obj(f.parent);
    const parentFields = obj(parentRaw.fields);
    const epicLink = this.opts.epicLinkField ? f[this.opts.epicLinkField] : undefined;
    // An epic sits at hierarchy level 1 whatever the site calls it; fall back to the name when Jira omits the level.
    const parentType = obj(parentFields.issuetype);
    const parentIsEpic =
      typeof parentType.hierarchyLevel === "number"
        ? parentType.hierarchyLevel === 1
        : str(parentType.name).toLowerCase() === "epic";
    const parent =
      typeof parentRaw.key === "string" && parentRaw.key
        ? {
            key: parentRaw.key,
            ...(str(parentFields.summary) ? { title: str(parentFields.summary) } : {}),
            kind: parentIsEpic ? "epic" : "parent",
          }
        : typeof epicLink === "string" && epicLink
          ? { key: epicLink, kind: "epic" }
          : undefined;
    return {
      key,
      ...(str(f.summary) ? { title: str(f.summary) } : {}),
      ...(str(obj(f.issuetype).name) ? { type: str(obj(f.issuetype).name) } : {}),
      url: this.issueUrl(key),
      scopeKey: str(obj(f.project).key) || projectOf(key),
      ...(parent ? { parent } : {}),
    };
  }

  async search(
    jql: string,
    opts: { maxResults: number; timeoutMs?: number; retryOn429?: boolean },
  ): Promise<IssueSearchResult> {
    await this.ready();
    const r = await this.client.request<Json>(
      "POST",
      "/rest/api/3/search/jql",
      { jql, maxResults: opts.maxResults, fields: ["summary", "status", "issuetype", "updated"] },
      { timeoutMs: opts.timeoutMs, retryOn429: opts.retryOn429 },
    );
    const issues = (Array.isArray(r.issues) ? r.issues : []).map(obj).map((i) => {
      const f = obj(i.fields);
      return {
        key: str(i.key),
        summary: str(f.summary),
        status: str(obj(f.status).name),
        issueType: str(obj(f.issuetype).name),
        updated: str(f.updated),
        url: this.issueUrl(str(i.key)),
      };
    });
    return { issues, truncated: typeof r.nextPageToken === "string" };
  }

  async matchesJql(
    key: string,
    jql: string,
    opts: { timeoutMs?: number; retryOn429?: boolean } = {},
  ): Promise<boolean> {
    await this.ready();
    const r = await this.search(`issuekey = ${key} AND (${jql})`, { maxResults: 1, ...opts });
    return r.issues.length > 0;
  }

  async comment(
    key: string,
    input: { markdown: string; visibilityRole?: string; issueKeyProjects?: readonly string[] },
    opts?: TrackerCallOptions,
  ): Promise<{ id: string; url: string }> {
    const budget = callBudget(opts);
    await this.ready(budget);
    const r = await this.client.request<Json>(
      "POST",
      `/rest/api/3/issue/${key}/comment`,
      {
        body: this.toAdf(input.markdown, input.issueKeyProjects),
        ...(input.visibilityRole ? { visibility: { type: "role", value: input.visibilityRole } } : {}),
      },
      budget.request(),
    );
    if (typeof r.id !== "string") throw new IssueTrackerError("tracker_invalid_response");
    return { id: r.id, url: `${this.issueUrl(key)}?focusedCommentId=${r.id}` };
  }

  async editComment(
    key: string,
    commentId: string,
    input: { markdown: string; issueKeyProjects?: readonly string[] },
  ): Promise<void> {
    await this.ready();
    await this.client.request("PUT", `/rest/api/3/issue/${key}/comment/${commentId}`, {
      body: this.toAdf(input.markdown, input.issueKeyProjects),
    });
  }

  async readComment(key: string, commentId: string): Promise<{ authorId: string | null; body: string } | null> {
    await this.ready();
    try {
      const c = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/comment/${commentId}`);
      return { authorId: person(c.author)?.accountId ?? null, body: adfToText(c.body, Infinity) };
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
      throw err;
    }
  }

  async transitions(key: string): Promise<Array<{ id: string; name: string; toStatus: string; toCategory: string }>> {
    await this.ready();
    const r = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/transitions`);
    return (Array.isArray(r.transitions) ? r.transitions : []).map(obj).map((t) => ({
      id: str(t.id),
      name: str(t.name),
      toStatus: str(obj(t.to).name),
      toCategory: str(obj(obj(t.to).statusCategory).key),
    }));
  }

  async transitionTo(key: string, toStatus: string): Promise<{ transitionId: string; toStatus: string }> {
    await this.ready();
    const wanted = toStatus.trim().toLowerCase();
    const match = (await this.transitions(key)).find((t) => t.toStatus.toLowerCase() === wanted);
    if (!match)
      throw new IssueTrackerError(
        "tracker_invalid_request",
        `No transition to "${toStatus}" is available from this issue's current status.`,
      );
    try {
      await this.client.request(
        "POST",
        `/rest/api/3/issue/${key}/transitions`,
        { transition: { id: match.id } },
        { allowEmpty: true },
      );
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_invalid_request")
        throw new IssueTrackerError(
          "tracker_invalid_request",
          "This transition needs fields wardby can't fill (a transition screen); do it in Jira.",
        );
      throw err;
    }
    return { transitionId: match.id, toStatus: match.toStatus };
  }

  async editableFields(key: string): Promise<string[]> {
    await this.ready();
    const r = await this.client.request<Json>("GET", `/rest/api/3/issue/${key}/editmeta`);
    return Object.keys(obj(r.fields));
  }

  async editFields(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.ready();
    const body: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(fields)) {
      if (id === "components" && Array.isArray(value)) body[id] = value.map((name: unknown) => ({ name }));
      else if (id === "priority" && typeof value === "string") body[id] = { name: value };
      else body[id] = value;
    }
    await this.client.request("PUT", `/rest/api/3/issue/${key}`, { fields: body }, { allowEmpty: true });
  }

  async linkTypes(opts?: TrackerCallOptions): Promise<Array<{ name: string; inward: string; outward: string }>> {
    const budget = callBudget(opts);
    await this.ready(budget);
    const r = await this.client.request<Json>("GET", "/rest/api/3/issueLinkType", undefined, budget.request());
    return (Array.isArray(r.issueLinkTypes) ? r.issueLinkTypes : []).map(obj).map((t) => ({
      name: str(t.name),
      inward: str(t.inward),
      outward: str(t.outward),
    }));
  }

  async linkIssues(
    input: { type: string; inwardKey: string; outwardKey: string },
    opts?: TrackerCallOptions,
  ): Promise<void> {
    const budget = callBudget(opts);
    await this.ready(budget);
    await this.client.request(
      "POST",
      "/rest/api/3/issueLink",
      {
        type: { name: input.type },
        inwardIssue: { key: input.inwardKey },
        outwardIssue: { key: input.outwardKey },
      },
      budget.request({ allowEmpty: true }),
    );
  }

  async addRemoteLink(
    key: string,
    input: { globalId: string; url: string; title: string; status?: { resolved: boolean } },
  ): Promise<void> {
    await this.ready();
    await this.client.request(
      "POST",
      `/rest/api/3/issue/${key}/remotelink`,
      {
        globalId: input.globalId,
        object: { url: input.url, title: input.title, ...(input.status ? { status: input.status } : {}) },
      },
      { allowEmpty: true },
    );
  }

  async getProperty(key: string, property: string): Promise<unknown> {
    await this.ready();
    try {
      const r = await this.client.request<Json>(
        "GET",
        `/rest/api/3/issue/${key}/properties/${encodeURIComponent(property)}`,
      );
      return r.value ?? null;
    } catch (err) {
      if (err instanceof IssueTrackerError && err.code === "tracker_not_found") return null;
      throw err;
    }
  }

  async setProperty(key: string, property: string, value: unknown): Promise<void> {
    await this.ready();
    await this.client.request("PUT", `/rest/api/3/issue/${key}/properties/${encodeURIComponent(property)}`, value, {
      allowEmpty: true,
    });
  }

  /** Pages a createmeta endpoint (startAt/maxResults/total), capped. */
  private async pagedMeta(path: string, listKey: string, budget: CallBudget): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 0, startAt = 0; page < META_MAX_PAGES; page++) {
      const r = await this.client.request<Json>(
        "GET",
        `${path}?startAt=${startAt}&maxResults=${META_PAGE_SIZE}`,
        undefined,
        budget.request(),
      );
      const items = Array.isArray(r[listKey]) ? r[listKey].map(obj) : [];
      out.push(...items);
      startAt += items.length;
      if (items.length === 0 || (typeof r.total === "number" ? startAt >= r.total : items.length < META_PAGE_SIZE))
        break;
    }
    return out;
  }

  async createMeta(
    projectKey: string,
    budget: CallBudget = callBudget(),
  ): Promise<{ issueTypes: CreateMetaIssueType[] }> {
    await this.ready(budget);
    const items = await this.pagedMeta(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      "issueTypes",
      budget,
    );
    return {
      issueTypes: items
        .filter((t) => str(t.id) !== "")
        .map((t) => ({ id: str(t.id), name: str(t.name), subtask: t.subtask === true })),
    };
  }

  async fieldMeta(
    projectKey: string,
    issueTypeId: string,
    budget: CallBudget = callBudget(),
  ): Promise<CreateMetaField[]> {
    await this.ready(budget);
    const items = await this.pagedMeta(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
      "fields",
      budget,
    );
    return items
      .filter((f) => str(f.fieldId) !== "")
      .map((f) => {
        const allowed = Array.isArray(f.allowedValues)
          ? f.allowedValues.map((v) => str(obj(v).name) || str(obj(v).value) || str(obj(v).id)).filter(Boolean)
          : [];
        return {
          fieldId: str(f.fieldId),
          name: str(f.name),
          required: f.required === true,
          hasDefault: f.hasDefaultValue === true,
          ...(allowed.length > 0 ? { allowedValues: allowed } : {}),
        };
      });
  }

  async createIssue(input: CreateIssueInput, opts?: TrackerCallOptions): Promise<{ key: string; url: string }> {
    const budget = callBudget(opts);
    await this.ready(budget);
    const wanted = input.issueType.trim().toLowerCase();
    const type = (await this.createMeta(input.projectKey, budget)).issueTypes.find(
      (t) => t.name.toLowerCase() === wanted,
    );
    if (!type)
      throw new IssueTrackerError(
        "tracker_invalid_request",
        `Issue type "${input.issueType}" is not available in project ${input.projectKey}.`,
      );
    const fields: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(input.customFields ?? {})) {
      if (!/^customfield_\d+$/.test(id))
        throw new IssueTrackerError(
          "tracker_invalid_request",
          `customFields may only set customfield_N fields; "${id}" is not allowed.`,
        );
      fields[id] = value;
    }
    if (type.subtask && !input.parentKey)
      throw new IssueTrackerError("tracker_invalid_request", `Sub-task issues need a parent (${type.name}).`);
    // Core fields are applied last so nothing above can override them.
    Object.assign(fields, {
      project: { key: input.projectKey },
      issuetype: { id: type.id },
      summary: input.summary,
      description: this.toAdf(input.descriptionMarkdown, input.issueKeyProjects),
    });
    if (input.labels) fields.labels = input.labels;
    if (input.priority) fields.priority = { name: input.priority };
    if (input.components) fields.components = input.components.map((name) => ({ name }));
    if (input.parentKey) fields.parent = { key: input.parentKey };
    const missing = (await this.fieldMeta(input.projectKey, type.id, budget))
      .filter((f) => f.required && !f.hasDefault && !ALWAYS_SUPPLIED.has(f.fieldId) && fields[f.fieldId] === undefined)
      .map((f) => f.name || f.fieldId);
    if (missing.length > 0)
      throw new IssueTrackerError(
        "tracker_invalid_request",
        `Required fields are missing for ${type.name} in ${input.projectKey}: ${missing.join(", ")}.`,
      );
    const properties = Object.entries(input.properties ?? {}).map(([key, value]) => ({ key, value }));
    const r = await this.client.request<Json>(
      "POST",
      "/rest/api/3/issue",
      { fields, ...(properties.length > 0 ? { properties } : {}) },
      budget.request(),
    );
    if (typeof r.key !== "string" || !r.key) throw new IssueTrackerError("tracker_invalid_response");
    return { key: r.key, url: this.issueUrl(r.key) };
  }

  async readAttachmentText(
    id: string,
    maxBytes: number,
  ): Promise<{ filename: string; mimeType: string; text: string; truncated: boolean }> {
    await this.ready();
    const meta = await this.client.request<Json>("GET", `/rest/api/3/attachment/${encodeURIComponent(id)}`);
    const filename = str(meta.filename);
    const mimeType = str(meta.mimeType);
    if (!isTextMime(mimeType))
      throw new IssueTrackerError(
        "tracker_invalid_request",
        `Attachment "${filename}" is ${mimeType || "of unknown type"}; only text-like attachments can be read.`,
      );
    const size = typeof meta.size === "number" ? meta.size : null;
    const cap = Math.max(1, Math.floor(maxBytes));
    if (size === 0) return { filename, mimeType, text: "", truncated: false };
    // redirect=false: Jira serves the bytes itself (206 with Range) instead of a 303 to the media host.
    // A Range reaching past the end of the file is answered with a Content-Length of the requested
    // length and the connection is then cut short, so only ask for a range when the file is larger.
    const whole = size !== null && size <= cap;
    const bytes = await this.client.requestBytes(
      `/rest/api/3/attachment/content/${encodeURIComponent(id)}?redirect=false`,
      whole ? { maxBytes: size, range: false } : { maxBytes: cap },
    );
    return {
      filename,
      mimeType,
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      truncated: size === null ? bytes.length >= cap : size > cap,
    };
  }
}
