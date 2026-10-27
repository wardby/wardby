import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";

vi.mock("../../../../src/core/host-events.js", () => ({
  routeHostEvent: vi.fn(async () => ({ runIds: ["run1"], followUps: [] })),
}));
import { routeHostEvent } from "../../../../src/core/host-events.js";
import { handleGitHubEventIngress } from "../../../../src/mcp/host-events/github-ingress.js";
import { verifyGitHubSignature } from "../../../../src/providers/review-host/github-events.js";
import { githubHarness, OWNER, REPO, type Harness } from "./harness.test-support.js";
import { SIM_APP_ID, SIM_APP_SLUG } from "./test-app-key.js";

const SECRET = "sim-webhook-secret";

/** A receiver running wardby's real GitHub ingress (routing mocked), answering scripted statuses first. */
async function ingressReceiver(
  scripted: number[] = [],
): Promise<{ url: string; server: Server; answers: number[]; bodies: string[] }> {
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
  const answers: number[] = [];
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        bodies.push(rawBody);
        const forced = scripted.shift();
        if (forced !== undefined) {
          answers.push(forced);
          res.writeHead(forced).end();
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
        );
        const result = await handleGitHubEventIngress(
          { headers, rawBody },
          {
            db: { hostEventDelivery } as never,
            executor: {} as never,
            hosts: {},
            repoAccess: { authorizeUse: vi.fn(), authorizeHostUser: vi.fn(), authorizePrincipal: vi.fn() },
            webhookSecret: SECRET,
            appIdentity: async () => ({ id: SIM_APP_ID, slug: SIM_APP_SLUG, ownerLogin: OWNER }),
            allowedAccounts: () => new Set<string>(),
          },
        );
        answers.push(result.status);
        res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hosts/github/events`,
    server,
    answers,
    bodies,
  };
}

let h: Harness;
let receiver: Awaited<ReturnType<typeof ingressReceiver>> | undefined;
beforeEach(async () => {
  vi.mocked(routeHostEvent).mockClear();
  h = await githubHarness();
});
afterEach(async () => {
  receiver?.server.close();
  receiver = undefined;
  h.gh.git.dispose();
  await h.sim.close();
});

async function subscribe(url: string, events: string[] = []): Promise<void> {
  await h.script([{ action: "github.webhook_subscribe", url, secret: SECRET, events }]);
}

async function flush(): Promise<any[]> {
  const [result] = (await h.script([{ action: "github.webhook_flush" }])) as { deliveries: any[] }[];
  return result.deliveries;
}

describe("GitHub sim webhooks", () => {
  it("signs every delivery so wardby's own verifier accepts it, and routes a mention once", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url);
    await h.script([
      { action: "github.collaborator", repo: REPO, login: "dev", role: "write" },
      {
        action: "github.issue",
        repo: REPO,
        title: "Add a joke",
        body: `@${SIM_APP_SLUG} please build this`,
        author: "dev",
      },
    ]);
    const deliveries = await flush();
    expect(deliveries).toEqual([
      expect.objectContaining({
        event: "issues",
        action: "opened",
        delivered: true,
        attempts: [expect.objectContaining({ status: 202 })],
      }),
    ]);
    expect(deliveries[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const payload = JSON.parse(receiver.bodies[0]);
    expect(payload).toMatchObject({
      action: "opened",
      issue: { number: 1, author_association: "COLLABORATOR", user: { login: "dev", type: "User" } },
      repository: { full_name: REPO, default_branch: "main" },
      sender: { login: "dev" },
      installation: { id: 42 },
    });
    expect(verifyGitHubSignature(receiver.bodies[0], `sha256=${"0".repeat(64)}`, SECRET)).toBe(false);
    expect(routeHostEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeHostEvent).mock.calls[0][0]).toMatchObject({ kind: "mention", number: 1, author: "dev" });
  });

  it("a duplicate delivery id is answered as a duplicate and routed once", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url);
    await h.script([{ action: "github.issue", repo: REPO, title: `@${SIM_APP_SLUG} do it`, author: OWNER }]);
    const [first] = await flush();
    await h.script([{ action: "github.webhook_redeliver", id: first.id }]);
    const deliveries = await flush();
    expect(deliveries.map((d) => d.id)).toEqual([first.id, first.id]);
    expect(receiver.answers).toEqual([202, 202]);
    expect(routeHostEvent).toHaveBeenCalledTimes(1);
  });

  it("retries after a scripted 500 with the same delivery id, and the retry is routed", async () => {
    receiver = await ingressReceiver([500]);
    await subscribe(receiver.url);
    await h.script([{ action: "github.issue", repo: REPO, title: `@${SIM_APP_SLUG} do it`, author: OWNER }]);
    const [delivery] = await flush();
    expect(delivery.attempts.map((a: any) => a.status)).toEqual([500, 202]);
    expect(delivery.delivered).toBe(true);
    expect(routeHostEvent).toHaveBeenCalledTimes(1);
  });

  it("gives up after three failed attempts", async () => {
    receiver = await ingressReceiver([503, 503, 503]);
    await subscribe(receiver.url);
    await h.script([{ action: "github.issue", repo: REPO, title: "plain", author: OWNER }]);
    const [delivery] = await flush();
    expect(delivery).toMatchObject({ delivered: false, attempts: [{ status: 503 }, { status: 503 }, { status: 503 }] });
  });

  it("an outsider's mention carries author_association NONE and a repository permission of read", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url, ["issue_comment"]);
    await h.script([
      { action: "github.issue", repo: REPO, title: "Bug", author: OWNER },
      { action: "github.comment", repo: REPO, number: 1, author: "outsider", body: `@${SIM_APP_SLUG} build it` },
    ]);
    await flush();
    const payload = JSON.parse(receiver.bodies[0]);
    expect(payload.comment).toMatchObject({ author_association: "NONE", user: { login: "outsider" } });
    const token = await h.mint({ metadata: "read" });
    expect(
      (await h.call("GET", `/repos/${REPO}/collaborators/outsider/permission`, undefined, { token })).body.permission,
    ).toBe("read");
  });

  it("filters by event, and sends pull_request opened/synchronize/ready and push on the default branch", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url, ["pull_request", "push"]);
    await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "b\n" } },
      { action: "github.pull", repo: REPO, head: "feature", title: "Feature", author: OWNER },
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "c\n" } },
      { action: "github.commit", repo: REPO, branch: "main", files: { "m.txt": "m\n" } },
    ]);
    const deliveries = await flush();
    expect(deliveries.map((d) => `${d.event}.${d.action ?? ""}`)).toEqual([
      "push.",
      "pull_request.opened",
      "push.",
      "pull_request.synchronize",
      "push.",
    ]);
    const mainPush = JSON.parse(deliveries[4].body);
    expect(mainPush).toMatchObject({ ref: "refs/heads/main", commits: [{ added: ["m.txt"] }] });
    expect(mainPush.before).toMatch(/^[0-9a-f]{40}$/);
    const sync = JSON.parse(deliveries[3].body);
    expect(sync.pull_request.head.sha).toBe(sync.after);
  });

  it("sends pull_request_review, pull_request_review_comment and issue_comment from the App's own writes", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url, ["pull_request_review", "pull_request_review_comment", "issue_comment"]);
    await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "b\n" } },
      { action: "github.pull", repo: REPO, head: "feature", title: "Feature", author: OWNER },
    ]);
    const token = await h.mint({ pull_requests: "write" });
    await h.call(
      "POST",
      `/repos/${REPO}/pulls/1/reviews`,
      { event: "COMMENT", body: "b", comments: [{ path: "b.txt", line: 1, body: "x" }] },
      { token },
    );
    await h.call("POST", `/repos/${REPO}/issues/1/comments`, { body: "status" }, { token });
    const deliveries = await flush();
    expect(deliveries.map((d) => `${d.event}.${d.action}`)).toEqual([
      "pull_request_review_comment.created",
      "pull_request_review.submitted",
      "issue_comment.created",
    ]);
    expect(JSON.parse(deliveries[2].body).comment.performed_via_github_app).toEqual({
      id: SIM_APP_ID,
      slug: SIM_APP_SLUG,
    });
  });

  it("sends check_suite completed once every run of one App on the head is done, with its open PRs", async () => {
    receiver = await ingressReceiver();
    await subscribe(receiver.url, ["check_suite"]);
    await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "b\n" } },
      { action: "github.pull", repo: REPO, head: "feature", title: "Feature", author: OWNER },
      { action: "github.check", repo: REPO, ref: "feature", name: "build", status: "in_progress" },
      { action: "github.check", repo: REPO, ref: "feature", name: "lint", conclusion: "success" },
    ]);
    expect(await flush()).toEqual([]);
    const [build] = [...h.gh.checkRuns.values()].filter((r) => r.name === "build");
    build.status = "completed";
    build.conclusion = "failure";
    await h.gh.checkChanged(h.gh.repo(REPO)!, build.headSha);
    const deliveries = await flush();
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0].body).check_suite).toMatchObject({
      conclusion: "failure",
      app: { id: 15368 },
      pull_requests: [{ number: 1 }],
    });
    // wardby's ingress ignores its own App's suite, but routes another App's CI completion.
    expect(vi.mocked(routeHostEvent).mock.calls.at(-1)?.[0]).toMatchObject({ kind: "ci_completed", prNumbers: [1] });
  });

  it("refuses a subscription URL with credentials, and lists the delivery log over the control API", async () => {
    await expect(
      h.script([{ action: "github.webhook_subscribe", url: "http://user:pw@127.0.0.1/x", secret: SECRET }]),
    ).rejects.toThrow();
    receiver = await ingressReceiver();
    await subscribe(receiver.url);
    await h.script([{ action: "github.issue", repo: REPO, title: "plain", author: OWNER }]);
    await flush();
    const [log] = (await h.script([{ action: "github.webhook_deliveries" }])) as { deliveries: any[] }[];
    expect(log.deliveries).toHaveLength(1);
  });
});
