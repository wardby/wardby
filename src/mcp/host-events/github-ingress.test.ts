import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";

vi.mock("../../core/host-events.js", () => ({
  routeHostEvent: vi.fn(async () => ({ runIds: ["run1"], followUps: [vi.fn(async () => undefined)] })),
}));
import { routeHostEvent } from "../../core/host-events.js";
import { handleGitHubEventIngress } from "./github-ingress.js";

const SECRET = "s3cret";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const body = JSON.stringify({
  action: "opened",
  repository: { full_name: "chfields/knock-knock-jokes" },
  pull_request: { number: 7, head: { sha: SHA, repo: { full_name: "chfields/knock-knock-jokes" } } },
});
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

const REPO_ACCESS = { authorizeUse: vi.fn(), authorizeHostUser: vi.fn(), authorizePrincipal: vi.fn() };

function deps(overrides: Record<string, unknown> = {}) {
  const created: string[] = [];
  const hostEventDelivery = {
    create: vi.fn(async ({ data }: { data: { deliveryId: string } }) => {
      if (created.includes(data.deliveryId)) {
        throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
      }
      created.push(data.deliveryId);
    }),
    deleteMany: vi.fn(async ({ where }: { where: { deliveryId?: string; receivedAt?: unknown } }) => {
      if (where.deliveryId === undefined) return { count: 0 };
      const idx = created.indexOf(where.deliveryId);
      if (idx === -1) return { count: 0 };
      created.splice(idx, 1);
      return { count: 1 };
    }),
  };
  return {
    created,
    hostEventDelivery,
    deps: {
      db: { hostEventDelivery } as never,
      executor: {} as never,
      hosts: {},
      repoAccess: REPO_ACCESS,
      webhookSecret: SECRET,
      appIdentity: async () => ({ id: 777, slug: "wardby" }),
      ...overrides,
    },
  };
}

const headers = (h: Record<string, string>) => ({ "x-github-event": "pull_request", "x-github-delivery": "d1", ...h });

describe("handleGitHubEventIngress", () => {
  beforeEach(() => {
    vi.mocked(routeHostEvent).mockClear();
  });

  it("is disabled without a configured secret", async () => {
    const { deps: d } = deps({ webhookSecret: undefined });
    expect((await handleGitHubEventIngress({ headers: headers({}), rawBody: body }, d)).status).toBe(404);
  });

  it("rejects a bad signature without routing", async () => {
    const { deps: d } = deps();
    const result = await handleGitHubEventIngress(
      { headers: headers({ "x-hub-signature-256": "sha256=00" }), rawBody: body },
      d,
    );
    expect(result.status).toBe(401);
    expect(routeHostEvent).not.toHaveBeenCalled();
  });

  it("routes a signed event once and treats a redelivery as done", async () => {
    const { deps: d } = deps();
    const req = { headers: headers({ "x-hub-signature-256": sign(body) }), rawBody: body };
    const first = await handleGitHubEventIngress(req, d);
    expect(first).toMatchObject({ status: 202, body: { runIds: ["run1"] } });
    await first.afterResponse?.();
    const again = await handleGitHubEventIngress(req, d);
    expect(again).toMatchObject({ status: 202, body: { duplicate: true } });
    expect(routeHostEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeHostEvent).mock.calls[0][1].repoAccess).toBe(REPO_ACCESS);
  });

  it("accepts and ignores events it does not handle", async () => {
    const { deps: d } = deps();
    const raw = JSON.stringify({ repository: { full_name: "chfields/knock-knock-jokes" } });
    const result = await handleGitHubEventIngress(
      {
        headers: { "x-github-event": "push", "x-github-delivery": "d2", "x-hub-signature-256": sign(raw) },
        rawBody: raw,
      },
      d,
    );
    expect(result).toMatchObject({ status: 202, body: { ignored: true } });
  });

  it("does not record a delivery for an event it ignores", async () => {
    const { deps: d, created, hostEventDelivery } = deps();
    const raw = JSON.stringify({ repository: { full_name: "chfields/knock-knock-jokes" } });
    const result = await handleGitHubEventIngress(
      {
        headers: { "x-github-event": "push", "x-github-delivery": "d2", "x-hub-signature-256": sign(raw) },
        rawBody: raw,
      },
      d,
    );
    expect(result).toMatchObject({ status: 202, body: { ignored: true } });
    expect(created).toEqual([]);
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
  });

  it("requires a delivery id", async () => {
    const { deps: d } = deps();
    const result = await handleGitHubEventIngress(
      { headers: { "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }, rawBody: body },
      d,
    );
    expect(result.status).toBe(400);
  });

  it("un-marks the delivery on a routing failure so the retry is routed, not reported duplicate", async () => {
    const { deps: d, created } = deps();
    vi.mocked(routeHostEvent).mockRejectedValueOnce(new Error("transient failure"));
    const req = { headers: headers({ "x-hub-signature-256": sign(body) }), rawBody: body };

    await expect(handleGitHubEventIngress(req, d)).rejects.toThrow("transient failure");
    expect(created).toEqual([]);

    const retried = await handleGitHubEventIngress(req, d);
    expect(retried).toMatchObject({ status: 202, body: { runIds: ["run1"] } });
    expect(routeHostEvent).toHaveBeenCalledTimes(2);
  });
});
