/**
 * Jira Cloud webhook → host-neutral IssueEvent. Pure: no I/O. The signature
 * is WebSub-style (X-Hub-Signature: <method>=<hex HMAC of the raw body>);
 * only sha256 is accepted. Actors that aren't licensed humans (JSM
 * customers, apps) and the bot itself never produce an event.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { adfMentionIds, adfToText } from "./adf.js";
import { ISSUE_KEY, projectOf, type IssueEvent, type IssueEventKind } from "./types.js";

/**
 * Kept whole here: the task builder (core/issue-events.ts) cuts the
 * description and comment to the shared untrusted body limit and marks the
 * cut, which needs the whole length. Jira's own field limit and the webhook
 * body already bound it.
 */
const MAX_TEXT = Infinity;

export function verifyJiraSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const presented = Buffer.from(header.slice("sha256=".length), "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function humanActor(user: unknown, bot: string): { accountId: string; displayName: string } | null {
  const u = obj(user);
  if (!u || typeof u.accountId !== "string" || u.accountType !== "atlassian" || u.accountId === bot) return null;
  return { accountId: u.accountId, displayName: str(u.displayName) };
}

const words = (s: unknown): string[] => str(s).split(/\s+/).filter(Boolean);

function getChangelogField(item: Json, field: string): unknown {
  return (item as Record<string, unknown>)[field];
}

export function normalizeJiraEvent(payload: unknown, botAccountId: string): IssueEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const event = str(p.webhookEvent);
  const issue = obj(p.issue);
  const issueKey = str(issue?.key);
  if (!ISSUE_KEY.test(issueKey)) return null;
  const fields = obj(issue?.fields);
  const subject = fields
    ? { summary: str(fields.summary).slice(0, 256), description: adfToText(fields.description, MAX_TEXT) }
    : undefined;
  const base = {
    provider: "jira" as const,
    projectKey: projectOf(issueKey),
    issueKey,
    addedLabels: [] as string[],
    ...(subject ? { subject } : {}),
  };

  if (event === "jira:issue_created") {
    const actor = humanActor(p.user, botAccountId);
    return actor ? { ...base, kinds: ["created"], actor } : null;
  }
  if (event === "jira:issue_updated") {
    const actor = humanActor(p.user, botAccountId);
    if (!actor) return null;
    const items = Array.isArray(obj(p.changelog)?.items) ? (obj(p.changelog)!.items as unknown[]).map(obj) : [];
    const kinds: IssueEventKind[] = [];
    const out: IssueEvent = { ...base, kinds, actor };
    for (const item of items) {
      if (!item) continue;
      if (item.field === "status" && str(getChangelogField(item, "toString"))) {
        kinds.push("transitioned");
        out.toStatus = str(getChangelogField(item, "toString"));
      } else if (item.field === "labels") {
        const before = new Set(words(getChangelogField(item, "fromString")));
        const added = words(getChangelogField(item, "toString")).filter((l) => !before.has(l));
        if (added.length) {
          kinds.push("labeled");
          out.addedLabels = added;
        }
      } else if (item.field === "assignee" && typeof item.to === "string" && item.to) {
        kinds.push("assigned");
        out.assigneeAccountId = item.to;
      }
    }
    return kinds.length ? out : null;
  }
  if (event === "comment_created" || event === "comment_updated") {
    const comment = obj(p.comment);
    // An edit is attributed to the editor, never the original author:
    // otherwise anyone who can edit others' comments could reuse a trusted
    // user's mention to pass the allowlist.
    const actor =
      event === "comment_updated"
        ? humanActor(comment?.updateAuthor, botAccountId)
        : humanActor(comment?.author ?? p.user, botAccountId);
    if (!actor || !comment || typeof comment.id !== "string") return null;
    if (!adfMentionIds(comment.body).includes(botAccountId)) return null;
    return { ...base, kinds: ["mention"], actor, comment: { id: comment.id, body: adfToText(comment.body, MAX_TEXT) } };
  }
  return null;
}
