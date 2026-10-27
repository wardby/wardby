// TEST ONLY (wardby-sim). The Jira Cloud REST v3 subset wardby calls (src/providers/issue-tracker/
// jira.ts), mounted at /jira (the base WARDBY_TEST_SIMULATORS gives wardby's Jira client):
//
//   GET  /rest/api/3/myself                                  the token's account (accountType, locale)
//   GET  /rest/api/3/issue/{key}?fields=...                  fields incl. ADF description and comments
//   PUT  /rest/api/3/issue/{key}                             labels / priority / components / customfield_*
//   GET  /rest/api/3/issue/{key}/editmeta
//   GET  /rest/api/3/issue/{key}/comment                     paged list (startAt/maxResults)
//   POST /rest/api/3/issue/{key}/comment                     ADF body (400 otherwise), role visibility
//   GET  /rest/api/3/issue/{key}/comment/{id}
//   PUT  /rest/api/3/issue/{key}/comment/{id}                the author only (403 otherwise)
//   GET  /rest/api/3/issue/{key}/transitions
//   POST /rest/api/3/issue/{key}/transitions                 204; 400 for a transition not offered
//   GET  /rest/api/3/issue/{key}/remotelink
//   POST /rest/api/3/issue/{key}/remotelink                  upsert by globalId (201 new, 200 update)
//   GET  /rest/api/3/issue/{key}/properties/{property}
//   PUT  /rest/api/3/issue/{key}/properties/{property}       201 new, 200 update, empty body
//   POST /rest/api/3/search/jql                              the JQL subset in jql.ts; nextPageToken
//   GET  /rest/api/3/issueLinkType
//   POST /rest/api/3/issueLink                               201, empty body
//
// Every route takes `Authorization: Bearer <token>` (401 for a missing, unknown or revoked one).
// Writes by the service account fire the webhooks Jira would (comment_created / comment_updated,
// jira:issue_updated with a changelog), with the service account as the actor.
import { empty, header, json, jsonBody, record, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { RouteContext } from "../service.js";
import { compileJql, JqlError } from "./jql.js";
import {
  adfToWiki,
  isAdfDoc,
  LINK_TYPES,
  SIM_JIRA_SITE,
  type JiraComment,
  type JiraIssue,
  type JiraState,
  type JiraStatus,
  type JiraSubscription,
  type JiraUser,
} from "./state.js";
import type { JiraWebhooks } from "./webhooks.js";

const API = "/rest/api/3";
const CATEGORY = {
  new: { id: 2, key: "new", name: "To Do", colorName: "blue-gray" },
  indeterminate: { id: 4, key: "indeterminate", name: "In Progress", colorName: "yellow" },
  done: { id: 3, key: "done", name: "Done", colorName: "green" },
} as const;

const errors = (status: number, ...messages: string[]): SimResponse =>
  json({ errorMessages: messages, errors: {} }, status);

export function userJson(user: JiraUser | undefined, accountId: string): Record<string, unknown> {
  return {
    self: `${SIM_JIRA_SITE}${API}/user?accountId=${accountId}`,
    accountId,
    accountType: user?.accountType ?? "atlassian",
    displayName: user?.displayName ?? "Former user",
    active: true,
    timeZone: "Etc/UTC",
    avatarUrls: { "48x48": `${SIM_JIRA_SITE}/avatar/${accountId}.png` },
  };
}

export function statusJson(status: JiraStatus): Record<string, unknown> {
  return {
    self: `${SIM_JIRA_SITE}${API}/status/${status.id}`,
    id: status.id,
    name: status.name,
    statusCategory: CATEGORY[status.category as keyof typeof CATEGORY] ?? CATEGORY.indeterminate,
  };
}

export function commentJson(
  jira: JiraState,
  issue: JiraIssue,
  comment: JiraComment,
  format: "adf" | "wiki" = "adf",
): Record<string, unknown> {
  return {
    self: `${SIM_JIRA_SITE}${API}/issue/${issue.id}/comment/${comment.id}`,
    id: comment.id,
    author: userJson(jira.users.get(comment.author), comment.author),
    body: format === "adf" ? comment.body : adfToWiki(comment.body),
    updateAuthor: userJson(jira.users.get(comment.updateAuthor), comment.updateAuthor),
    created: comment.created,
    updated: comment.updated,
    jsdPublic: true,
    ...(comment.visibility ? { visibility: comment.visibility } : {}),
  };
}

const ALL_FIELDS = [
  "project",
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "comment",
  "attachment",
  "issuelinks",
  "parent",
  "created",
  "updated",
];

/** An issue as GET /issue returns it; `fields` limits the fields (Jira's `fields` parameter). */
export function issueJson(
  jira: JiraState,
  issue: JiraIssue,
  opts: { fields?: string[]; format?: "adf" | "wiki" } = {},
): Record<string, unknown> {
  const format = opts.format ?? "adf";
  const want = new Set(opts.fields && !opts.fields.includes("*all") ? opts.fields : ALL_FIELDS);
  const project = jira.project(issue);
  const fields: Record<string, unknown> = {};
  const put = (name: string, value: () => unknown) => {
    if (want.has(name)) fields[name] = value();
  };
  put("project", () => ({ id: project.id, key: project.key, name: project.name }));
  put("summary", () => issue.summary);
  put("description", () =>
    issue.description === null ? null : format === "adf" ? issue.description : adfToWiki(issue.description),
  );
  put("status", () => statusJson(jira.status(issue)));
  put("issuetype", () => ({ ...issue.issueType }));
  put("priority", () => (issue.priority ? { name: issue.priority, id: "3" } : null));
  put("labels", () => [...issue.labels]);
  put("assignee", () => (issue.assignee ? userJson(jira.users.get(issue.assignee), issue.assignee) : null));
  put("reporter", () => userJson(jira.users.get(issue.reporter), issue.reporter));
  put("comment", () => ({
    comments: issue.comments.map((c) => commentJson(jira, issue, c, format)),
    self: `${SIM_JIRA_SITE}${API}/issue/${issue.id}/comment`,
    maxResults: issue.comments.length,
    total: issue.comments.length,
    startAt: 0,
  }));
  put("attachment", () => []);
  put("issuelinks", () =>
    issue.links.map((link, index) => {
      const type = LINK_TYPES.find((t) => t.name === link.type) ?? LINK_TYPES[2];
      const outward = link.inwardKey === issue.key;
      const otherKey = outward ? link.outwardKey : link.inwardKey;
      const other = jira.issue(otherKey);
      const brief = other
        ? { key: other.key, id: other.id, fields: { summary: other.summary, status: statusJson(jira.status(other)) } }
        : { key: otherKey };
      return { id: String(index + 1), type, ...(outward ? { outwardIssue: brief } : { inwardIssue: brief }) };
    }),
  );
  put("parent", () => {
    const parent = issue.parentKey ? jira.issue(issue.parentKey) : undefined;
    return parent
      ? { key: parent.key, id: parent.id, fields: { summary: parent.summary, issuetype: { ...parent.issueType } } }
      : undefined;
  });
  put("created", () => issue.created);
  put("updated", () => issue.updated);
  if (fields.parent === undefined) delete fields.parent;
  return { id: issue.id, key: issue.key, self: `${SIM_JIRA_SITE}${API}/issue/${issue.id}`, fields };
}

/** The webhook body of an issue event (issue + optional changelog), in a subscription's format. */
export function issueEventBody(
  jira: JiraState,
  issue: JiraIssue,
  actor: string,
  typeName: string,
  items: Record<string, unknown>[] | undefined,
  subscription: JiraSubscription,
): Record<string, unknown> {
  const fields = ALL_FIELDS.filter((f) => f !== "comment");
  return {
    issue_event_type_name: typeName,
    user: userJson(jira.users.get(actor), actor),
    issue: issueJson(jira, issue, { fields, format: subscription.bodyFormat }),
    ...(items ? { changelog: { id: String(Date.now()), items } } : {}),
  };
}

/** The webhook body of a comment event. */
export function commentEventBody(
  jira: JiraState,
  issue: JiraIssue,
  comment: JiraComment,
  subscription: JiraSubscription,
): Record<string, unknown> {
  return {
    comment: commentJson(jira, issue, comment, subscription.bodyFormat),
    issue: issueJson(jira, issue, {
      fields: ["summary", "status", "issuetype", "project", "priority", "assignee"],
      format: subscription.bodyFormat,
    }),
  };
}

export interface JiraEvents {
  issueUpdated(issue: JiraIssue, actor: string, typeName: string, items: Record<string, unknown>[]): void;
  comment(event: "comment_created" | "comment_updated", issue: JiraIssue, comment: JiraComment): void;
}

export function jiraEvents(jira: JiraState, hooks: JiraWebhooks): JiraEvents {
  return {
    issueUpdated: (issue, actor, typeName, items) =>
      void hooks.send("jira:issue_updated", (s) => issueEventBody(jira, issue, actor, typeName, items, s)),
    comment: (event, issue, comment) => void hooks.send(event, (s) => commentEventBody(jira, issue, comment, s)),
  };
}

export function jiraRestRouter(jira: JiraState, events: JiraEvents): Router {
  /** The calling account, or the 401 Jira answers. */
  const caller = (req: SimRequest, ctx: RouteContext): string | SimResponse => {
    const match = /^Bearer\s+(.+)$/i.exec(header(req, "authorization") ?? "");
    const token = match ? jira.tokens.get(match[1]) : undefined;
    if (!token || token.revoked) return errors(401, "Client must be authenticated to access this resource.");
    ctx.principal(`jira:${token.accountId}`);
    return token.accountId;
  };
  /** The caller and the issue, or the error response (401, or 404 as Jira hides what you cannot see). */
  const withIssue = (
    req: SimRequest,
    params: Record<string, string>,
    ctx: RouteContext,
  ): { actor: string; issue: JiraIssue } | SimResponse => {
    const actor = caller(req, ctx);
    if (typeof actor !== "string") return actor;
    const issue = jira.issue(params.key);
    if (!issue) return errors(404, "Issue does not exist or you do not have permission to see it.");
    return { actor, issue };
  };
  const failed = (value: unknown): value is SimResponse =>
    !!value && typeof value === "object" && "status" in value && typeof (value as SimResponse).status === "number";

  return new Router()
    .on("GET", `${API}/myself`, (req, _p, ctx) => {
      const actor = caller(req, ctx);
      if (failed(actor)) return actor;
      const user = jira.users.get(actor);
      return json({ ...userJson(user, actor), locale: user?.locale ?? "en_US", groups: { size: 0, items: [] } });
    })
    .on("GET", `${API}/issue/{key}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const fields = req.query.get("fields");
      return json(issueJson(jira, found.issue, fields ? { fields: fields.split(",").map((f) => f.trim()) } : {}));
    })
    .on("PUT", `${API}/issue/{key}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const fields = record(record(jsonBody(req)).fields);
      const items: Record<string, unknown>[] = [];
      for (const [id, value] of Object.entries(fields)) {
        if (id === "labels" && Array.isArray(value)) {
          const before = found.issue.labels.join(" ");
          found.issue.labels = value.map((v) => textOf(v)).filter(Boolean);
          items.push({
            field: "labels",
            fieldtype: "jira",
            fieldId: "labels",
            fromString: before,
            toString: found.issue.labels.join(" "),
          });
        } else if (id === "priority") {
          found.issue.priority = textOf(record(value).name) || found.issue.priority;
        } else if (id === "components" || /^customfield_\d+$/.test(id)) {
          // Accepted and not modelled further.
        } else {
          return json(
            {
              errorMessages: [],
              errors: { [id]: `Field '${id}' cannot be set. It is not on the appropriate screen, or unknown.` },
            },
            400,
          );
        }
      }
      found.issue.updated = jira.tick();
      if (items.length > 0) events.issueUpdated(found.issue, found.actor, "issue_updated", items);
      return empty(204);
    })
    .on("GET", `${API}/issue/{key}/editmeta`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const field = (name: string) => ({ required: false, name, operations: ["set"] });
      return json({
        fields: { labels: field("Labels"), priority: field("Priority"), components: field("Components") },
      });
    })
    .on("GET", `${API}/issue/{key}/comment`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const startAt = Math.max(0, Number(req.query.get("startAt") ?? 0) || 0);
      const maxResults = Math.min(5000, Math.max(1, Number(req.query.get("maxResults") ?? 5000) || 5000));
      const all = found.issue.comments;
      return json({
        startAt,
        maxResults,
        total: all.length,
        comments: all.slice(startAt, startAt + maxResults).map((c) => commentJson(jira, found.issue, c)),
      });
    })
    .on("POST", `${API}/issue/{key}/comment`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const body = record(jsonBody(req));
      if (!isAdfDoc(body.body))
        return json({ errorMessages: [], errors: { comment: "Comment body is not valid!" } }, 400);
      const visibility = record(body.visibility);
      if (body.visibility !== undefined) {
        const role = textOf(visibility.value);
        if (visibility.type !== "role" || !jira.project(found.issue).roles.includes(role)) {
          return json(
            {
              errorMessages: [],
              errors: { commentLevel: `You are currently not a member of the project role: ${role}.` },
            },
            400,
          );
        }
      }
      const comment = jira.addComment(
        found.issue,
        found.actor,
        body.body,
        body.visibility !== undefined ? { type: "role", value: textOf(visibility.value) } : undefined,
      );
      events.comment("comment_created", found.issue, comment);
      return json(commentJson(jira, found.issue, comment), 201);
    })
    .on("GET", `${API}/issue/{key}/comment/{id}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const comment = found.issue.comments.find((c) => c.id === params.id);
      if (!comment) return errors(404, "Can not find a comment for the id: " + params.id + ".");
      return json(commentJson(jira, found.issue, comment));
    })
    .on("PUT", `${API}/issue/{key}/comment/{id}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const comment = found.issue.comments.find((c) => c.id === params.id);
      if (!comment) return errors(404, "Can not find a comment for the id: " + params.id + ".");
      // A service account has Edit Own Comments, not Edit All Comments.
      if (comment.author !== found.actor) return errors(403, "You do not have the permission to edit this comment.");
      const body = record(jsonBody(req));
      if (!isAdfDoc(body.body))
        return json({ errorMessages: [], errors: { comment: "Comment body is not valid!" } }, 400);
      jira.editComment(found.issue, comment, found.actor, body.body);
      events.comment("comment_updated", found.issue, comment);
      return json(commentJson(jira, found.issue, comment));
    })
    .on("GET", `${API}/issue/{key}/transitions`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      return json({
        expand: "transitions",
        transitions: jira.transitionsFor(found.issue).map((t) => ({
          id: t.id,
          name: t.name,
          to: statusJson(t.to),
          hasScreen: false,
          isGlobal: true,
          isInitial: false,
          isAvailable: true,
          isConditional: false,
          isLooped: false,
        })),
      });
    })
    .on("POST", `${API}/issue/{key}/transitions`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const id = textOf(record(record(jsonBody(req)).transition).id);
      const transition = jira.transitionsFor(found.issue).find((t) => t.id === id);
      if (!transition) return errors(400, `Transition id '${id}' is not valid for this issue.`);
      const { from, to } = jira.moveTo(found.issue, transition.to.id, found.actor);
      events.issueUpdated(found.issue, found.actor, "issue_generic", [
        {
          field: "status",
          fieldtype: "jira",
          fieldId: "status",
          from: from.id,
          fromString: from.name,
          to: to.id,
          toString: to.name,
        },
      ]);
      return empty(204);
    })
    .on("GET", `${API}/issue/{key}/remotelink`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      return json(
        found.issue.remoteLinks.map((l) => ({
          id: l.id,
          self: `${SIM_JIRA_SITE}${API}/issue/${found.issue.key}/remotelink/${l.id}`,
          globalId: l.globalId,
          object: l.object,
        })),
      );
    })
    .on("POST", `${API}/issue/{key}/remotelink`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      const body = record(jsonBody(req));
      const object = record(body.object);
      const url = textOf(object.url);
      const title = textOf(object.title);
      if (!url || !title) return json({ errorMessages: [], errors: { [url ? "title" : "url"]: "is required" } }, 400);
      const status = record(object.status);
      const { link, created } = jira.upsertRemoteLink(found.issue, textOf(body.globalId), {
        url,
        title,
        ...(object.status !== undefined ? { status: { resolved: status.resolved === true } } : {}),
      });
      return json(
        { id: link.id, self: `${SIM_JIRA_SITE}${API}/issue/${found.issue.key}/remotelink/${link.id}` },
        created ? 201 : 200,
      );
    })
    .on("GET", `${API}/issue/{key}/properties/{property}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      if (!found.issue.properties.has(params.property))
        return errors(404, `The property with key '${params.property}' does not exist.`);
      return json({ key: params.property, value: found.issue.properties.get(params.property) });
    })
    .on("PUT", `${API}/issue/{key}/properties/{property}`, (req, params, ctx) => {
      const found = withIssue(req, params, ctx);
      if (failed(found)) return found;
      if (req.rawBody.length === 0) return errors(400, "The property value must be valid JSON.");
      const value = jsonBody(req);
      if (value === undefined) return errors(400, "The property value must be valid JSON.");
      if (req.rawBody.length > 32_768) return errors(400, "The property value is too long (32,768 bytes at most).");
      const existed = found.issue.properties.has(params.property);
      found.issue.properties.set(params.property, value);
      return empty(existed ? 200 : 201);
    })
    .on("POST", `${API}/search/jql`, (req, _p, ctx) => {
      const actor = caller(req, ctx);
      if (failed(actor)) return actor;
      const body = record(jsonBody(req));
      let match;
      try {
        match = compileJql(textOf(body.jql), jira);
      } catch (error) {
        if (error instanceof JqlError) return errors(400, error.message);
        throw error;
      }
      const maxResults = Math.min(5000, Math.max(1, Number(body.maxResults ?? 50) || 50));
      const start = Number(textOf(body.nextPageToken) || 0) || 0;
      const fields = Array.isArray(body.fields) ? body.fields.map((f) => textOf(f)) : ["id"];
      const hits = [...jira.issues.values()].filter(match).sort((a, b) => Number(b.id) - Number(a.id));
      const page = hits.slice(start, start + maxResults);
      return json({
        issues: page.map((i) => issueJson(jira, i, { fields })),
        isLast: start + maxResults >= hits.length,
        ...(start + maxResults < hits.length ? { nextPageToken: String(start + maxResults) } : {}),
      });
    })
    .on("GET", `${API}/issueLinkType`, (req, _p, ctx) => {
      const actor = caller(req, ctx);
      if (failed(actor)) return actor;
      return json({
        issueLinkTypes: LINK_TYPES.map((t) => ({ ...t, self: `${SIM_JIRA_SITE}${API}/issueLinkType/${t.id}` })),
      });
    })
    .on("POST", `${API}/issueLink`, (req, _p, ctx) => {
      const actor = caller(req, ctx);
      if (failed(actor)) return actor;
      const body = record(jsonBody(req));
      const type = LINK_TYPES.find((t) => t.name.toLowerCase() === textOf(record(body.type).name).toLowerCase());
      const inward = jira.issue(textOf(record(body.inwardIssue).key));
      const outward = jira.issue(textOf(record(body.outwardIssue).key));
      if (!type) return errors(404, "No issue link type with name found.");
      if (!inward || !outward) return errors(404, "Issue Does Not Exist");
      const link = { type: type.name, inwardKey: inward.key, outwardKey: outward.key };
      inward.links.push(link);
      if (outward !== inward) outward.links.push(link);
      return empty(201);
    });
}
