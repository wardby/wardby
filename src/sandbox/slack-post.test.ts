/**
 * slack.post in the sandbox (#529): the bridge validates its arguments,
 * forwards to the invocation's host-side SlackConnection, caps the number of
 * posts per call, and throws connection_unavailable when the invocation has
 * no connection (agent runs, dry_run_tool, anything but a granted hook).
 */
import { describe, expect, it } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { SharedDatastoreAccessor } from "../core/datastores.js";
import { SLACK_POST_LIMIT, type SlackConnection } from "./host-functions.js";
import { runInSandbox } from "./run-in-sandbox.js";

const datastore = {} as Datastore;
const sharedDatastore = {} as SharedDatastoreAccessor;

function fakeSlack() {
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const slack: SlackConnection = {
    async post(channel, text, threadTs) {
      posts.push({ channel, text, ...(threadTs ? { threadTs } : {}) });
      return { ts: `1700000000.00010${posts.length}` };
    },
  };
  return { slack, posts };
}

const run = (code: string, slack?: SlackConnection) =>
  runInSandbox({
    code,
    params: {},
    agentId: "a",
    datastore,
    sharedDatastore,
    toolName: "t",
    ...(slack ? { slack } : {}),
  });

describe("slack.post", () => {
  it("posts through the connection and returns the message ts", async () => {
    const { slack, posts } = fakeSlack();
    const result = await run(
      `const first = await slack.post("c0abc", "hello");
       const reply = await slack.post("C0ABC", "in thread", { threadTs: first.ts });
       return [first.ts, reply.ts];`,
      slack,
    );
    expect(result).toEqual({ ok: true, value: ["1700000000.000101", "1700000000.000102"] });
    expect(posts).toEqual([
      { channel: "C0ABC", text: "hello" },
      { channel: "C0ABC", text: "in thread", threadTs: "1700000000.000101" },
    ]);
  });

  it("throws connection_unavailable without a connection", async () => {
    const result = await run(`return await slack.post("C0ABC", "hello");`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toContain("connection_unavailable");
  });

  it.each([
    ["a bad channel", `await slack.post("#general", "x")`],
    ["empty text", `await slack.post("C0ABC", "")`],
    ["text over the limit", `await slack.post("C0ABC", "x".repeat(40001))`],
    ["a bad threadTs", `await slack.post("C0ABC", "x", { threadTs: "yesterday" })`],
  ])("refuses %s", async (_label, code) => {
    const { slack, posts } = fakeSlack();
    const result = await run(code, slack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toContain("slack_bad_args");
    expect(posts).toHaveLength(0);
  });

  it(`stops after ${SLACK_POST_LIMIT} posts in one call`, async () => {
    const { slack, posts } = fakeSlack();
    const result = await run(
      `for (let i = 0; i < ${SLACK_POST_LIMIT + 1}; i++) await slack.post("C0ABC", "n" + i);`,
      slack,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorMessage).toContain("slack_post_limit");
    expect(posts).toHaveLength(SLACK_POST_LIMIT);
  });
});
