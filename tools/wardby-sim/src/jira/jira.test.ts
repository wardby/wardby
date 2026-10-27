import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";

vi.mock("../../../../src/core/issue-events.js", () => ({
  routeIssueEvent: vi.fn(async () => ({ runIds: ["run1"], followUps: [] })),
}));
import { routeIssueEvent } from "../../../../src/core/issue-events.js";
import { handleJiraEventIngress } from "../../../../src/mcp/host-events/jira-ingress.js";
import { JiraClient } from "../../../../src/providers/issue-tracker/jira-client.js";
import { JiraIssueTracker } from "../../../../src/providers/issue-tracker/jira.js";
import { IssueTrackerError } from "../../../../src/providers/issue-tracker/types.js";
import { createSimServer, simRequest, type SimServer } from "../server.js";
import { createJiraSim, JIRA_PREFIX, type JiraSim } from "./service.js";
import { SIM_JIRA_BOT, SIM_JIRA_DEV, SIM_JIRA_SITE, SIM_JIRA_TOKEN } from "./state.js";

const SECRET = "jira-sim-webhook-secret-0123456789";

let sim: SimServer;
let jira: JiraSim;
const script = async (steps: Record<string, unknown>[]): Promise<any[]> => {
  const response = await sim.dispatch(simRequest("POST", "/__sim/script", { steps }));
  const body = JSON.parse(String(response.body)) as { results: any[]; error?: string; message?: string };
  if (response.status !== 200) throw new Error(`${body.error} ${body.message ?? ""}`);
  return body.results;
};
const inspect = async (key: string) => (await script([{ action: "jira.inspect", key }]))[0].issues[0];

/** In-process fetch onto the simulator (no socket). */
const simFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const response = await sim.dispatch(
    simRequest(
      init?.method ?? "GET",
      `${url.pathname}${url.search}`,
      typeof init?.body === "string" ? init.body : undefined,
      headers,
    ),
  );
  return new Response(response.status === 204 ? null : (response.body ?? null), {
    status: response.status,
    headers: response.headers ?? {},
  });
}) as typeof fetch;

/** wardby's real Jira client and tracker, its requests answered by the simulator. */
function tracker(token = SIM_JIRA_TOKEN, sleeps: number[] = []): JiraIssueTracker {
  const client = new JiraClient({ apiBaseUrl: `https://sim.invalid${JIRA_PREFIX}`, auth: { token } } as never, {
    fetch: simFetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return new JiraIssueTracker(client, SIM_JIRA_SITE);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    expect(error).toBeInstanceOf(IssueTrackerError);
    return (error as IssueTrackerError).code;
  }
}

beforeEach(async () => {
  jira = createJiraSim({ webhooks: { retryDelayMs: 5 } });
  sim = createSimServer({ services: [jira.service] });
  await script([
    { action: "jira.project", key: "WID", name: "Widgets" },
    { action: "jira.issue", project: "WID", summary: "Add a joke", description: "Please add a knock-knock joke." },
  ]);
});
afterEach(async () => {
  await sim.close();
});

describe("Jira sim through wardby's own Jira client", () => {
  it("myself: the service account (app), and the locale wardby takes", async () => {
    const t = tracker();
    expect(await t.identity()).toEqual({ accountId: SIM_JIRA_BOT, displayName: "wardby (sim)", accountType: "app" });
    expect(await t.botAccountId()).toBe(SIM_JIRA_BOT);
  });

  it("401 for a missing, unknown or revoked token, recorded without the token", async () => {
    expect(await codeOf(tracker("sim-unknown").identity())).toBe("tracker_permission_denied");
    await script([{ action: "jira.token", token: SIM_JIRA_TOKEN, revoked: true }]);
    expect(await codeOf(tracker().identity())).toBe("tracker_permission_denied");
    const calls = sim.state.calls.list({ service: "jira" });
    expect(calls.every((c) => c.auth === "bearer" && c.status === 401)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(SIM_JIRA_TOKEN);
  });

  it("refuses a person's token (accountType atlassian), as wardby requires", async () => {
    await script([{ action: "jira.token", token: "sim-person", accountId: SIM_JIRA_DEV }]);
    expect(await codeOf(tracker("sim-person").getIssue("WID-1", { maxComments: 5, agentMarker: "a1" }))).toBe(
      "tracker_permission_denied",
    );
  });

  it("issue get with fields: ADF description as text, status, people, comments without wardby's status comments", async () => {
    const t = tracker();
    await script([{ action: "jira.comment", key: "WID-1", text: "A note from Dana." }]);
    await t.comment("WID-1", { markdown: "Working on it.\n\n_wardby run run-1_" });
    const view = await t.getIssue("WID-1", { maxComments: 10, agentMarker: "agent-1" });
    expect(view).toMatchObject({
      key: "WID-1",
      projectKey: "WID",
      summary: "Add a joke",
      status: "To Do",
      statusCategory: "new",
      issueType: "Task",
      reporter: { accountId: SIM_JIRA_DEV, displayName: "Dana Dev" },
      url: `${SIM_JIRA_SITE}/browse/WID-1`,
    });
    expect(view.description).toContain("knock-knock joke");
    expect(view.comments.map((c) => c.body.trim())).toEqual(["A note from Dana."]);
    const call = sim.state.calls
      .list({ service: "jira", method: "GET" })
      .find((c) => c.path === "/rest/api/3/issue/WID-1");
    expect(call?.query).toContain("fields=");
    expect(await codeOf(t.getIssue("WID-404", { maxComments: 1, agentMarker: "a" }))).toBe("tracker_not_found");
  });

  it("comments: create (ADF), read, edit own, list; another's comment cannot be edited", async () => {
    const t = tracker();
    const posted = await t.comment("WID-1", { markdown: "Hello **there**, see WID-1.", issueKeyProjects: ["WID"] });
    expect(posted.url).toBe(`${SIM_JIRA_SITE}/browse/WID-1?focusedCommentId=${posted.id}`);
    expect(await t.readComment("WID-1", posted.id)).toMatchObject({ authorId: SIM_JIRA_BOT });
    await t.editComment("WID-1", posted.id, { markdown: "Edited." });
    const issue = await inspect("WID-1");
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]).toMatchObject({ author: SIM_JIRA_BOT, text: "Edited.", edits: 1 });
    expect(issue.comments[0].history[0]).toContain("Hello there");
    const listed = await sim.dispatch(
      simRequest("GET", "/jira/rest/api/3/issue/WID-1/comment?maxResults=1", undefined, {
        authorization: `Bearer ${SIM_JIRA_TOKEN}`,
      }),
    );
    expect(JSON.parse(String(listed.body))).toMatchObject({ total: 1, startAt: 0 });
    const [{ id: theirs }] = await script([{ action: "jira.comment", key: "WID-1", text: "Mine." }]);
    expect(await codeOf(t.editComment("WID-1", theirs, { markdown: "Hijacked." }))).toBe("tracker_permission_denied");
    expect(await t.readComment("WID-1", "999999")).toBeNull();
  });

  it("a comment body that is not ADF is a 400; an unknown visibility role too", async () => {
    const auth = { authorization: `Bearer ${SIM_JIRA_TOKEN}`, "content-type": "application/json" };
    const plain = await sim.dispatch(
      simRequest("POST", "/jira/rest/api/3/issue/WID-1/comment", { body: "text" }, auth),
    );
    expect(plain.status).toBe(400);
    expect(await codeOf(tracker().comment("WID-1", { markdown: "x", visibilityRole: "Nobody" }))).toBe(
      "tracker_invalid_request",
    );
    const roled = await tracker().comment("WID-1", { markdown: "x", visibilityRole: "Developers" });
    expect((await inspect("WID-1")).comments.find((c: { id: string }) => c.id === roled.id).visibility).toEqual({
      type: "role",
      value: "Developers",
    });
  });

  it("transitions: list, move by target status, refuse one not offered", async () => {
    const t = tracker();
    const offered = await t.transitions("WID-1");
    expect(offered.map((x) => x.toStatus)).toEqual(["In Progress", "In Review", "Done"]);
    expect(await t.transitionTo("WID-1", "in review")).toMatchObject({ toStatus: "In Review" });
    expect(await codeOf(t.transitionTo("WID-1", "Shipped"))).toBe("tracker_invalid_request");
    const auth = { authorization: `Bearer ${SIM_JIRA_TOKEN}`, "content-type": "application/json" };
    const bad = await sim.dispatch(
      simRequest("POST", "/jira/rest/api/3/issue/WID-1/transitions", { transition: { id: "99" } }, auth),
    );
    expect(bad.status).toBe(400);
    expect((await inspect("WID-1")).transitions).toEqual([{ by: SIM_JIRA_BOT, from: "To Do", to: "In Review" }]);
  });

  it("remote links upsert by globalId; properties round-trip", async () => {
    const t = tracker();
    const link = {
      globalId: "wardby:pr:github:acme/widgets#1",
      url: "https://github.com/acme/widgets/pull/1",
      title: "acme/widgets#1",
    };
    await t.addRemoteLink("WID-1", link);
    await t.addRemoteLink("WID-1", { ...link, status: { resolved: true } });
    const issue = await inspect("WID-1");
    expect(issue.remoteLinks).toHaveLength(1);
    expect(issue.remoteLinks[0]).toMatchObject({ writes: 2, object: { status: { resolved: true } } });
    const statuses = sim.state.calls.list({ service: "jira", method: "POST" }).map((c) => c.status);
    expect(statuses).toEqual([201, 200]);
    expect(await t.getProperty("WID-1", "wardby.x")).toBeNull();
    await t.setProperty("WID-1", "wardby.x", { n: 1 });
    expect(await t.getProperty("WID-1", "wardby.x")).toEqual({ n: 1 });
  });

  it("search/jql and matchesJql (wardby's jqlFilter), with a 400 for an unknown field", async () => {
    const t = tracker();
    await script([{ action: "jira.issue", project: "WID", summary: "Second", labels: ["wardby"] }]);
    expect(
      (await t.search("project = WID ORDER BY created DESC", { maxResults: 10 })).issues.map((i) => i.key),
    ).toEqual(["WID-2", "WID-1"]);
    expect((await t.search("project = WID", { maxResults: 1 })).truncated).toBe(true);
    expect(await t.matchesJql("WID-2", "labels in (wardby, other)")).toBe(true);
    expect(await t.matchesJql("WID-1", "labels = wardby")).toBe(false);
    expect(await t.matchesJql("WID-1", 'status = "To Do" AND NOT labels = x')).toBe(true);
    expect(await codeOf(t.search("nosuchfield = 1", { maxResults: 1 }))).toBe("tracker_invalid_request");
  });

  it("issue project, snapshot, editmeta and field edits, link types and links", async () => {
    const t = tracker();
    expect(await t.issueProject("WID-1")).toBe("WID");
    expect(await t.snapshotIssue("WID-1")).toEqual({
      key: "WID-1",
      title: "Add a joke",
      type: "Task",
      url: `${SIM_JIRA_SITE}/browse/WID-1`,
      scopeKey: "WID",
    });
    expect(await t.editableFields("WID-1")).toEqual(["labels", "priority", "components"]);
    await t.editFields("WID-1", { labels: ["a", "b"], priority: "High" });
    expect((await inspect("WID-1")).labels).toEqual(["a", "b"]);
    expect((await t.linkTypes()).map((l) => l.name)).toContain("Duplicate");
    await script([{ action: "jira.issue", project: "WID", summary: "Dup" }]);
    await t.linkIssues({ type: "Duplicate", inwardKey: "WID-1", outwardKey: "WID-2" });
    const view = await t.getIssue("WID-1", { maxComments: 0, agentMarker: "a" });
    expect(view.links).toEqual([{ relation: "duplicates", key: "WID-2", summary: "Dup", status: "To Do" }]);
  });

  it("a 429 with Retry-After is retried once by wardby's client: one comment, the wait honoured", async () => {
    const sleeps: number[] = [];
    const t = tracker(SIM_JIRA_TOKEN, sleeps);
    await t.identity();
    sim.state.faults.add({
      service: "jira",
      method: "POST",
      path: "/rest/api/3/issue/{key}/comment",
      mode: "once",
      response: { status: 429, headers: { "retry-after": "3" }, body: "" },
    });
    await t.comment("WID-1", { markdown: "Once." });
    expect(sleeps).toEqual([3000]);
    expect((await inspect("WID-1")).comments).toHaveLength(1);
    const posts = sim.state.calls.list({ service: "jira", method: "POST" }).map((c) => c.status);
    expect(posts).toEqual([429, 201]);
  });

  it("a sticky 429 surfaces tracker_rate_limited after one retry", async () => {
    const t = tracker();
    await t.identity();
    sim.state.faults.add({
      service: "jira",
      method: "POST",
      path: "/rest/api/3/issue/{key}/comment",
      mode: "sticky",
      response: { status: 429, headers: { "retry-after": "1" }, body: "" },
    });
    expect(await codeOf(t.comment("WID-1", { markdown: "x" }))).toBe("tracker_rate_limited");
    expect((await inspect("WID-1")).comments).toHaveLength(0);
  });
});

/** A receiver running wardby's real Jira ingress and event normaliser (routing mocked). */
async function ingressReceiver(scripted: number[] = []) {
  const created: string[] = [];
  const hostEventDelivery = {
    create: vi.fn(async ({ data }: { data: { deliveryId: string } }) => {
      if (created.includes(data.deliveryId)) {
        throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
      }
      created.push(data.deliveryId);
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const answers: { status: number; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const forced = scripted.shift();
        if (forced !== undefined) {
          answers.push({ status: forced, body: null });
          res.writeHead(forced).end();
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
        );
        const result = await handleJiraEventIngress(
          { headers, rawBody: Buffer.concat(chunks).toString("utf8") },
          {
            db: { hostEventDelivery } as never,
            executor: {} as never,
            trackers: { jira: tracker() },
            webhookSecret: SECRET,
          },
        );
        answers.push({ status: result.status, body: result.body });
        res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/jira/events`, server, answers };
}

describe("Jira sim webhooks through wardby's real ingress", () => {
  let receiver: Awaited<ReturnType<typeof ingressReceiver>> | undefined;
  const routed = () => vi.mocked(routeIssueEvent).mock.calls.map((c) => c[0]);
  beforeEach(() => vi.mocked(routeIssueEvent).mockClear());
  afterEach(() => receiver?.server.close());

  async function subscribe(scripted: number[] = [], extra: Record<string, unknown> = {}) {
    receiver = await ingressReceiver(scripted);
    await script([{ action: "jira.webhook_subscribe", url: receiver.url, secret: SECRET, ...extra }]);
    return receiver;
  }
  const flush = async () => (await script([{ action: "jira.webhook_flush" }]))[0].deliveries as any[];

  it("assignment to the bot and a label: signed, fresh, normalised and routed", async () => {
    const r = await subscribe();
    await script([
      { action: "jira.assign", key: "WID-1", accountId: SIM_JIRA_BOT },
      { action: "jira.label", key: "WID-1", add: ["wardby"] },
    ]);
    await flush();
    expect(r.answers.map((a) => a.status)).toEqual([202, 202]);
    expect(routed().map((e) => [e.issueKey, e.kinds, e.actor.accountId])).toEqual([
      ["WID-1", ["assigned"], SIM_JIRA_DEV],
      ["WID-1", ["labeled"], SIM_JIRA_DEV],
    ]);
    expect(routed()[0].assigneeAccountId).toBe(SIM_JIRA_BOT);
    expect(routed()[1].addedLabels).toEqual(["wardby"]);
    expect(routed()[0].subject?.description).toContain("knock-knock");
  });

  it("issue created and a status move by a person are routed; the bot's own writes are not", async () => {
    const r = await subscribe();
    await script([
      { action: "jira.issue", project: "WID", summary: "New" },
      { action: "jira.transition", key: "WID-1", to: "In Progress" },
    ]);
    await tracker().comment("WID-1", { markdown: "Working on it." });
    await tracker().transitionTo("WID-1", "In Review");
    const deliveries = await flush();
    expect(deliveries.map((d) => d.event)).toEqual([
      "jira:issue_created",
      "jira:issue_updated",
      "comment_created",
      "jira:issue_updated",
    ]);
    expect(r.answers.map((a) => a.body)).toEqual([
      { runIds: ["run1"] },
      { runIds: ["run1"] },
      { ignored: true },
      { ignored: true },
    ]);
    expect(routed().map((e) => e.kinds)).toEqual([["created"], ["transitioned"]]);
  });

  for (const bodyFormat of ["wiki", "adf"] as const) {
    it(`a comment mentioning the bot (${bodyFormat} body) is a mention; an edit is the editor's`, async () => {
      await subscribe([], { bodyFormat });
      const [{ id }] = await script([
        { action: "jira.comment", key: "WID-1", text: `@${SIM_JIRA_BOT} please build this` },
      ]);
      await script([{ action: "jira.comment", key: "WID-1", text: "no mention here" }]);
      await script([{ action: "jira.user", accountId: "sim-jira-other-0002", displayName: "Olly Other" }]);
      await script([
        { action: "jira.comment_edit", key: "WID-1", id, text: `@${SIM_JIRA_BOT} edited`, by: "sim-jira-other-0002" },
      ]);
      await flush();
      expect(routed().map((e) => [e.kinds, e.actor.accountId, e.comment?.id])).toEqual([
        [["mention"], SIM_JIRA_DEV, id],
        [["mention"], "sim-jira-other-0002", id],
      ]);
      expect(routed()[0].comment?.body).toContain("please build this");
    });
  }

  it("a duplicate delivery (same identifier) is answered duplicate and routed once", async () => {
    const r = await subscribe();
    await script([{ action: "jira.assign", key: "WID-1", accountId: SIM_JIRA_BOT }]);
    const [first] = await flush();
    await script([{ action: "jira.webhook_redeliver", id: first.id }]);
    expect(r.answers.map((a) => a.body)).toEqual([{ runIds: ["run1"] }, { duplicate: true }]);
    expect(routed()).toHaveLength(1);
  });

  it("a 500 is retried with the same identifier and the retry header, then routed once", async () => {
    const r = await subscribe([500]);
    await script([{ action: "jira.assign", key: "WID-1", accountId: SIM_JIRA_BOT }]);
    const [delivery] = await flush();
    expect(delivery.attempts.map((a: { status: number }) => a.status)).toEqual([500, 202]);
    expect(r.answers.map((a) => a.status)).toEqual([500, 202]);
    expect(routed()).toHaveLength(1);
  });

  it("a delivery signed with another secret is refused (401) on every attempt", async () => {
    receiver = await ingressReceiver();
    await script([{ action: "jira.webhook_subscribe", url: receiver.url, secret: "not-the-ingress-secret-000000" }]);
    await script([{ action: "jira.assign", key: "WID-1", accountId: SIM_JIRA_BOT }]);
    const [delivery] = await flush();
    expect(delivery.delivered).toBe(false);
    expect(receiver.answers.map((a) => a.status)).toEqual([401, 401, 401]);
    expect(routed()).toHaveLength(0);
  });

  it("subscriptions can filter events", async () => {
    await subscribe([], { events: ["comment_created"] });
    await script([{ action: "jira.assign", key: "WID-1", accountId: SIM_JIRA_BOT }]);
    expect(await flush()).toHaveLength(0);
  });
});
