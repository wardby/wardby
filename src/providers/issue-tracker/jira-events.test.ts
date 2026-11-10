import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeJiraEvent, verifyJiraSignature } from "./jira-events.js";

const BOT = "bot-1";
const human = { accountId: "u-1", accountType: "atlassian", displayName: "Ada" };
const issue = { key: "PROJ-7", fields: { summary: "Login fails", description: "Steps to repro" } };
const updated = (items: unknown[], user: unknown = human) => ({
  webhookEvent: "jira:issue_updated",
  user,
  issue,
  changelog: { items },
});
const mentionDoc = (id: string) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id, text: "@wardby" } },
        { type: "text", text: " please fix" },
      ],
    },
  ],
});

describe("verifyJiraSignature", () => {
  it("matches Atlassian's published test vector", () => {
    expect(
      verifyJiraSignature(
        "Hello World!",
        "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
  });
  it("rejects a wrong secret, a missing header, an unknown method, and a re-serialised body", () => {
    const body = '{"a":1}';
    const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyJiraSignature(body, sig, "other")).toBe(false);
    expect(verifyJiraSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyJiraSignature(body, sig.replace("sha256", "md5"), "s3cret")).toBe(false);
    expect(verifyJiraSignature('{"a": 1}', sig, "s3cret")).toBe(false);
  });
});

describe("normalizeJiraEvent", () => {
  it("maps issue_created", () => {
    expect(normalizeJiraEvent({ webhookEvent: "jira:issue_created", user: human, issue }, BOT)).toEqual({
      provider: "jira",
      projectKey: "PROJ",
      issueKey: "PROJ-7",
      kinds: ["created"],
      actor: { accountId: "u-1", displayName: "Ada" },
      addedLabels: [],
      subject: { summary: "Login fails", description: "Steps to repro" },
    });
  });
  it("maps a transition and an added label in one update", () => {
    const e = normalizeJiraEvent(
      updated([
        { field: "status", fromString: "To Do", toString: "Ready for agent" },
        { field: "labels", fromString: "a", toString: "a wardby" },
      ]),
      BOT,
    );
    expect(e).toMatchObject({
      kinds: ["transitioned", "labeled"],
      toStatus: "Ready for agent",
      addedLabels: ["wardby"],
    });
  });
  it("maps an assignment, ignoring un-assignment", () => {
    expect(normalizeJiraEvent(updated([{ field: "assignee", to: BOT, toString: "wardby" }]), BOT)).toMatchObject({
      kinds: ["assigned"],
      assigneeAccountId: BOT,
    });
    expect(normalizeJiraEvent(updated([{ field: "assignee", to: null }]), BOT)).toBeNull();
  });
  it("maps a comment that mentions the bot, and only that", () => {
    const comment = (id: string) => ({
      webhookEvent: "comment_created",
      issue,
      comment: { id: "99", author: human, body: mentionDoc(id) },
    });
    expect(normalizeJiraEvent(comment(BOT), BOT)).toMatchObject({
      kinds: ["mention"],
      comment: { id: "99", body: "@wardby please fix" },
    });
    expect(normalizeJiraEvent(comment("someone-else"), BOT)).toBeNull();
  });
  it("recognizes a wiki-markup mention in a string comment body (webhook v2 shape)", () => {
    const event = normalizeJiraEvent(
      {
        webhookEvent: "comment_created",
        issue,
        comment: { id: "99", author: human, body: "[~accountid:bot-1] please fix" },
      },
      BOT,
    );
    expect(event).toMatchObject({ kinds: ["mention"], actor: { accountId: "u-1" } });
    expect(event?.comment?.body).toContain("please fix");
    expect(event?.comment?.body).not.toContain("[~accountid:");
    expect(
      normalizeJiraEvent(
        { webhookEvent: "comment_created", issue, comment: { id: "99", author: human, body: "[~accountid:x] hi" } },
        BOT,
      ),
    ).toBeNull();
  });
  it("passes a string description through as text", () => {
    expect(normalizeJiraEvent({ webhookEvent: "jira:issue_created", user: human, issue }, BOT)?.subject).toEqual({
      summary: "Login fails",
      description: "Steps to repro",
    });
  });
  it("keeps a long description and comment whole, for the task builder to cut and mark", () => {
    const long = "d".repeat(70_000);
    const big = { ...issue, fields: { ...issue.fields, description: long } };
    expect(normalizeJiraEvent({ webhookEvent: "jira:issue_created", user: human, issue: big }, BOT)?.subject).toEqual({
      summary: "Login fails",
      description: long,
    });
    const mention = normalizeJiraEvent(
      {
        webhookEvent: "comment_created",
        issue,
        comment: { id: "99", author: human, body: `[~accountid:bot-1] ${long}` },
      },
      BOT,
    );
    expect(mention?.comment?.body).toBe(`@user ${long}`);
  });
  it("uses the editor, not the original author, as the actor of comment_updated", () => {
    const other = { accountId: "u-2", accountType: "atlassian", displayName: "Eve" };
    const edited = (updateAuthor: unknown) => ({
      webhookEvent: "comment_updated",
      issue,
      comment: { id: "99", author: human, ...(updateAuthor ? { updateAuthor } : {}), body: mentionDoc(BOT) },
      user: human,
    });
    expect(normalizeJiraEvent(edited(other), BOT)).toMatchObject({
      kinds: ["mention"],
      actor: { accountId: "u-2", displayName: "Eve" },
    });
    expect(normalizeJiraEvent(edited(undefined), BOT)).toBeNull();
    expect(normalizeJiraEvent(edited({ ...human, accountId: BOT }), BOT)).toBeNull();
    expect(normalizeJiraEvent(edited({ ...other, accountType: "app" }), BOT)).toBeNull();
  });
  it("drops the bot's own events, customers, apps, and actors without an accountId", () => {
    const created = (user: unknown) => normalizeJiraEvent({ webhookEvent: "jira:issue_created", user, issue }, BOT);
    expect(created({ ...human, accountId: BOT })).toBeNull();
    expect(created({ ...human, accountType: "customer" })).toBeNull();
    expect(created({ ...human, accountType: "app" })).toBeNull();
    expect(created({ accoundId: "u-1", accountType: "atlassian" })).toBeNull();
  });
  it("drops unknown events, bad keys, comment events without an issue, and no-op updates", () => {
    expect(normalizeJiraEvent({ webhookEvent: "jira:issue_deleted", user: human, issue }, BOT)).toBeNull();
    expect(
      normalizeJiraEvent({ webhookEvent: "jira:issue_created", user: human, issue: { key: "bad key" } }, BOT),
    ).toBeNull();
    expect(
      normalizeJiraEvent(
        { webhookEvent: "comment_created", comment: { id: "1", author: human, body: mentionDoc(BOT) } },
        BOT,
      ),
    ).toBeNull();
    expect(normalizeJiraEvent(updated([{ field: "summary", toString: "x" }]), BOT)).toBeNull();
  });
});
