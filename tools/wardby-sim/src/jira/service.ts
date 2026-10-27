// TEST ONLY (wardby-sim). The simulated Jira Cloud site (REST v3 at /jira, see rest.ts) and the
// scripted actions a test seeds and drives it with. People's actions (filing, assigning,
// labelling, moving and commenting on issues) fire the webhooks Jira would send, signed with
// the subscription's secret (webhooks.ts).
import { textOf } from "../http.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { issueEventBody, jiraEvents, jiraRestRouter } from "./rest.js";
import {
  adfFromText,
  adfMentions,
  adfText,
  JiraState,
  SIM_JIRA_DEV,
  type JiraIssue,
  type JiraSubscription,
} from "./state.js";
import { JiraWebhooks, type JiraWebhookOptions } from "./webhooks.js";

export const JIRA_PREFIX = "/jira";

export interface JiraSim {
  service: SimService;
  state: JiraState;
  webhooks: JiraWebhooks;
}

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string" && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is required`);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function createJiraSim(options: { webhooks?: JiraWebhookOptions } = {}): JiraSim {
  const jira = new JiraState();
  const hooks = new JiraWebhooks(jira, options.webhooks);
  const events = jiraEvents(jira, hooks);
  const router = jiraRestRouter(jira, events);

  const needIssue = (args: Record<string, unknown>): JiraIssue => {
    const issue = jira.issue(str(args, "key"));
    if (!issue) throw new Error("no such issue");
    return issue;
  };
  const sendIssueEvent = (
    event: string,
    issue: JiraIssue,
    actor: string,
    typeName: string,
    items?: Record<string, unknown>[],
  ) => hooks.send(event, (s: JiraSubscription) => issueEventBody(jira, issue, actor, typeName, items, s));
  const deliveryIds = (list: { id: string }[]) => list.map((d) => d.id);

  const actions: Record<string, ScriptAction> = {
    "jira.project": async (args) => {
      const project = jira.addProject(str(args, "key"), textOf(args.name) || undefined);
      if (Array.isArray(args.roles)) project.roles = strings(args.roles);
      return { key: project.key, id: project.id };
    },
    "jira.user": async (args) => {
      const accountId = str(args, "accountId");
      jira.users.set(accountId, {
        accountId,
        displayName: str(args, "displayName", accountId),
        accountType: str(args, "accountType", "atlassian"),
        locale: str(args, "locale", "en_US"),
      });
      return { accountId };
    },
    "jira.token": async (args) => {
      const token = str(args, "token");
      jira.tokens.set(token, {
        accountId: str(args, "accountId", jira.tokens.get(token)?.accountId ?? ""),
        revoked: args.revoked === true,
      });
      return { token: "set" };
    },
    /** Files an issue as a person; fires jira:issue_created. */
    "jira.issue": async (args) => {
      const reporter = str(args, "by", SIM_JIRA_DEV);
      const issue = jira.addIssue({
        projectKey: str(args, "project"),
        summary: str(args, "summary"),
        ...(typeof args.description === "string" ? { description: adfFromText(args.description, jira.users) } : {}),
        reporter,
        labels: strings(args.labels),
        assignee: typeof args.assignee === "string" ? args.assignee : null,
        ...(typeof args.issueType === "string" ? { issueType: args.issueType } : {}),
        ...(typeof args.parent === "string" ? { parentKey: args.parent } : {}),
      });
      const sent = args.silent === true ? [] : sendIssueEvent("jira:issue_created", issue, reporter, "issue_created");
      return { key: issue.key, id: issue.id, deliveries: deliveryIds(sent) };
    },
    /** Assigns an issue (to `accountId`, or unassigns with null) as a person. */
    "jira.assign": async (args) => {
      const issue = needIssue(args);
      const by = str(args, "by", SIM_JIRA_DEV);
      const to = typeof args.accountId === "string" ? args.accountId : null;
      const from = issue.assignee;
      issue.assignee = to;
      issue.updated = jira.tick();
      const name = (id: string | null) => (id ? (jira.users.get(id)?.displayName ?? id) : null);
      const sent = sendIssueEvent("jira:issue_updated", issue, by, "issue_assigned", [
        {
          field: "assignee",
          fieldtype: "jira",
          fieldId: "assignee",
          from,
          fromString: name(from),
          to,
          toString: name(to),
        },
      ]);
      return { key: issue.key, deliveries: deliveryIds(sent) };
    },
    /** Adds (and removes) labels as a person. */
    "jira.label": async (args) => {
      const issue = needIssue(args);
      const by = str(args, "by", SIM_JIRA_DEV);
      const before = issue.labels.join(" ");
      const remove = new Set(strings(args.remove));
      issue.labels = [...new Set([...issue.labels.filter((l) => !remove.has(l)), ...strings(args.add)])];
      issue.updated = jira.tick();
      const sent = sendIssueEvent("jira:issue_updated", issue, by, "issue_updated", [
        {
          field: "labels",
          fieldtype: "jira",
          fieldId: "labels",
          from: null,
          fromString: before,
          to: null,
          toString: issue.labels.join(" "),
        },
      ]);
      return { key: issue.key, labels: issue.labels, deliveries: deliveryIds(sent) };
    },
    /** Moves an issue to a status (by name) as a person. */
    "jira.transition": async (args) => {
      const issue = needIssue(args);
      const by = str(args, "by", SIM_JIRA_DEV);
      const wanted = str(args, "to").toLowerCase();
      const target = jira.project(issue).statuses.find((s) => s.name.toLowerCase() === wanted);
      if (!target) throw new Error("no such status");
      const { from, to } = jira.moveTo(issue, target.id, by);
      const sent = sendIssueEvent("jira:issue_updated", issue, by, "issue_generic", [
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
      return { key: issue.key, status: to.name, deliveries: deliveryIds(sent) };
    },
    /** Comments as a person; `@<accountId>` in the text is a mention. */
    "jira.comment": async (args) => {
      const issue = needIssue(args);
      const comment = jira.addComment(issue, str(args, "by", SIM_JIRA_DEV), adfFromText(str(args, "text"), jira.users));
      events.comment("comment_created", issue, comment);
      return { key: issue.key, id: comment.id };
    },
    "jira.comment_edit": async (args) => {
      const issue = needIssue(args);
      const comment = issue.comments.find((c) => c.id === str(args, "id"));
      if (!comment) throw new Error("no such comment");
      jira.editComment(issue, comment, str(args, "by", SIM_JIRA_DEV), adfFromText(str(args, "text"), jira.users));
      events.comment("comment_updated", issue, comment);
      return { key: issue.key, id: comment.id };
    },
    "jira.webhook_subscribe": async (args) => {
      const format = textOf(args.bodyFormat) === "adf" ? "adf" : "wiki";
      jira.subscriptions.push({
        url: str(args, "url"),
        secret: str(args, "secret"),
        events: strings(args.events),
        bodyFormat: format,
      });
      return { subscriptions: jira.subscriptions.length };
    },
    "jira.webhook_flush": async () => {
      await hooks.idle();
      return {
        deliveries: hooks.deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          url: d.url,
          attempts: d.attempts,
          delivered: d.delivered,
          redelivery: d.redelivery,
          payload: JSON.parse(d.body) as unknown,
        })),
      };
    },
    "jira.webhook_redeliver": async (args) => {
      const copy = hooks.redeliver(str(args, "id"));
      if (!copy) throw new Error("no such delivery");
      await hooks.idle();
      return { id: copy.id, attempts: copy.attempts, delivered: copy.delivered };
    },
    "jira.webhook_pause": async () => {
      hooks.pause();
      return { paused: true };
    },
    "jira.webhook_resume": async () => {
      hooks.resume();
      return { paused: false };
    },
    /** One issue (or all) as a test asserts on it: comments as text, status, moves, links, properties. */
    "jira.inspect": async (args) => {
      const pick = typeof args.key === "string" ? [needIssue(args)] : [...jira.issues.values()];
      return {
        issues: pick.map((issue) => ({
          key: issue.key,
          status: jira.status(issue).name,
          labels: issue.labels,
          assignee: issue.assignee,
          transitions: issue.transitions,
          comments: issue.comments.map((c) => ({
            id: c.id,
            author: c.author,
            text: adfText(c.body),
            mentions: adfMentions(c.body),
            edits: c.history.length,
            history: c.history.map(adfText),
            visibility: c.visibility ?? null,
          })),
          remoteLinks: issue.remoteLinks,
          properties: Object.fromEntries(issue.properties),
          links: issue.links,
        })),
      };
    },
  };

  const service: SimService = {
    name: "jira",
    prefix: JIRA_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init(state: SimState) {
      if (!state.part("jira")) {
        state.register("jira", {
          reset: () => {
            jira.reset();
            hooks.reset();
          },
        });
      }
    },
  };
  return { service, state: jira, webhooks: hooks };
}

export function createJiraService(): SimService {
  return createJiraSim().service;
}
