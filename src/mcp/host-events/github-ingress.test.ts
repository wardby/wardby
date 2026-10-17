import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";

const logged = vi.hoisted(() => [] as { level: string; payload: Record<string, unknown>; message: string }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (payload: Record<string, unknown>, message?: string): void => {
        logged.push({ level, payload, message: message ?? "" });
      };
    return {
      child: () => make(),
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      fatal: at("fatal"),
    };
  };
  return { logger: make() };
});
vi.mock("../../core/host-events.js", () => ({
  routeHostEvent: vi.fn(async () => ({ runIds: ["run1"], followUps: [vi.fn(async () => undefined)] })),
}));
import { routeHostEvent } from "../../core/host-events.js";
import { eventAccount, handleGitHubEventIngress } from "./github-ingress.js";

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
      appIdentity: async () => ({ id: 777, slug: "wardby", ownerLogin: "chfields" }),
      allowedAccounts: () => new Set<string>(),
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

  it("routes a closed PR with the issue trackers", async () => {
    const trackers = { jira: {} as never };
    const { deps: d } = deps({ issueTrackers: trackers });
    const raw = JSON.stringify({
      action: "closed",
      repository: { full_name: "chfields/knock-knock-jokes" },
      pull_request: { number: 7, merged: true },
    });
    const result = await handleGitHubEventIngress(
      { headers: headers({ "x-hub-signature-256": sign(raw) }), rawBody: raw },
      d,
    );
    expect(result.status).toBe(202);
    const [event, routeDeps] = vi.mocked(routeHostEvent).mock.calls[0];
    expect(event).toMatchObject({ kind: "pr_closed", prNumber: 7, merged: true });
    expect(routeDeps.issueTrackers).toBe(trackers);
  });

  it("un-marks a closed PR's delivery when the issue lookup fails, so GitHub's redelivery is routed", async () => {
    const { deps: d, created } = deps({ issueTrackers: { jira: {} as never } });
    vi.mocked(routeHostEvent).mockRejectedValueOnce(new Error("issue lookup failed"));
    const raw = JSON.stringify({
      action: "closed",
      repository: { full_name: "chfields/knock-knock-jokes" },
      pull_request: { number: 7, merged: true },
    });
    const req = { headers: headers({ "x-hub-signature-256": sign(raw) }), rawBody: raw };
    await expect(handleGitHubEventIngress(req, d)).rejects.toThrow("issue lookup failed");
    expect(created).toEqual([]);
    await expect(handleGitHubEventIngress(req, d)).resolves.toMatchObject({ status: 202 });
    expect(routeHostEvent).toHaveBeenCalledTimes(2);
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

  it("logs a mention the author pre-filter dropped, without its body, and claims no delivery", async () => {
    const { deps: d, created } = deps();
    const raw = JSON.stringify({
      action: "created",
      repository: { full_name: "chfields/knock-knock-jokes" },
      issue: { number: 7 },
      comment: {
        id: 4,
        body: "@wardby secret-looking request text",
        author_association: "FIRST_TIMER",
        user: { id: 1001, login: "someone", type: "User" },
      },
    });
    logged.length = 0;
    const result = await handleGitHubEventIngress(
      {
        headers: { "x-github-event": "issue_comment", "x-github-delivery": "d20", "x-hub-signature-256": sign(raw) },
        rawBody: raw,
      },
      d,
    );
    expect(result).toMatchObject({ status: 202, body: { ignored: true } });
    expect(created).toEqual([]);
    const line = logged.find((l) => l.message === "mention ignored: its author did not pass the pre-filter");
    expect(line).toMatchObject({
      level: "info",
      payload: {
        eventName: "issue_comment",
        repository: "chfields/knock-knock-jokes",
        association: "FIRST_TIMER",
        reason: "author_association",
        deliveryId: "d20",
      },
    });
    expect(JSON.stringify(logged)).not.toContain("secret-looking");
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

describe("trusted GitHub accounts", () => {
  beforeEach(() => {
    vi.mocked(routeHostEvent).mockClear();
  });
  const strangerBody = JSON.stringify({
    action: "opened",
    repository: { full_name: "stranger/repo" },
    pull_request: { number: 7, head: { sha: SHA, repo: { full_name: "stranger/repo" } } },
  });
  const installEvent = (action: string, login: string, delivery: string) => {
    const raw = JSON.stringify({ action, installation: { id: 991, account: { login } } });
    return {
      headers: { "x-github-event": "installation", "x-github-delivery": delivery, "x-hub-signature-256": sign(raw) },
      rawBody: raw,
    };
  };

  it("ignores an event from an account that is neither the owner nor listed, without claiming the delivery", async () => {
    const { deps: d, hostEventDelivery } = deps();
    const result = await handleGitHubEventIngress(
      { headers: headers({ "x-hub-signature-256": sign(strangerBody) }), rawBody: strangerBody },
      d,
    );
    expect(result).toMatchObject({ status: 202, body: { ignored: "account_not_allowed" } });
    expect(result.afterResponse).toBeUndefined();
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
    expect(routeHostEvent).not.toHaveBeenCalled();
  });

  it("routes an event from a listed account (case-insensitive)", async () => {
    const { deps: d } = deps({ allowedAccounts: () => new Set(["stranger"]) });
    const raw = strangerBody.replaceAll("stranger/", "Stranger/");
    const result = await handleGitHubEventIngress(
      { headers: headers({ "x-hub-signature-256": sign(raw) }), rawBody: raw },
      d,
    );
    expect(result).toMatchObject({ status: 202, body: { runIds: ["run1"] } });
  });

  it("uninstalls a new installation on an account that is not served", async () => {
    const uninstallInstallation = vi.fn(async () => undefined);
    const appIdentity = vi.fn(async () => ({ id: 777, slug: "wardby", ownerLogin: "chfields" }));
    const { deps: d, hostEventDelivery } = deps({ uninstallInstallation, appIdentity });
    const result = await handleGitHubEventIngress(installEvent("created", "Stranger", "d9"), d);
    expect(result).toMatchObject({ status: 202, body: { ignored: "account_not_allowed" } });
    await result.afterResponse!();
    expect(appIdentity).toHaveBeenLastCalledWith({ fresh: true });
    expect(uninstallInstallation).toHaveBeenCalledWith(991);
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
  });

  it("does not uninstall when a fresh owner read now serves the account", async () => {
    const uninstallInstallation = vi.fn(async () => undefined);
    const appIdentity = vi.fn(async (opts?: { fresh?: boolean }) => ({
      id: 777,
      slug: "wardby",
      ownerLogin: opts?.fresh ? "stranger" : "acme",
    }));
    const { deps: d } = deps({ uninstallInstallation, appIdentity });
    const result = await handleGitHubEventIngress(installEvent("created", "Stranger", "d13"), d);
    expect(result).toMatchObject({ status: 202, body: { ignored: "account_not_allowed" } });
    await result.afterResponse!();
    expect(appIdentity).toHaveBeenLastCalledWith({ fresh: true });
    expect(uninstallInstallation).not.toHaveBeenCalled();
  });

  it("does not uninstall when the fresh owner read fails", async () => {
    const uninstallInstallation = vi.fn(async () => undefined);
    const appIdentity = vi.fn(async (opts?: { fresh?: boolean }) => {
      if (opts?.fresh) throw new Error("github_api_unavailable");
      return { id: 777, slug: "wardby", ownerLogin: "acme" };
    });
    const { deps: d } = deps({ uninstallInstallation, appIdentity });
    const result = await handleGitHubEventIngress(installEvent("created", "stranger", "d14"), d);
    await expect(result.afterResponse!()).resolves.toBeUndefined();
    expect(uninstallInstallation).not.toHaveBeenCalled();
  });

  it("only logs when the uninstall itself fails", async () => {
    const uninstallInstallation = vi.fn(async () => {
      throw new Error("github_api_unavailable");
    });
    const { deps: d } = deps({ uninstallInstallation });
    const result = await handleGitHubEventIngress(installEvent("created", "stranger", "d15"), d);
    await expect(result.afterResponse!()).resolves.toBeUndefined();
    expect(uninstallInstallation).toHaveBeenCalledWith(991);
  });

  it("never uninstalls the owner's or a listed account's installation, nor on a deleted event", async () => {
    const uninstallInstallation = vi.fn(async () => undefined);
    const { deps: d } = deps({ uninstallInstallation, allowedAccounts: () => new Set(["acme"]) });
    expect(
      (await handleGitHubEventIngress(installEvent("deleted", "stranger", "d10"), d)).afterResponse,
    ).toBeUndefined();
    await handleGitHubEventIngress(installEvent("created", "CHFIELDS", "d11"), d);
    await handleGitHubEventIngress(installEvent("created", "acme", "d12"), d);
    expect(uninstallInstallation).not.toHaveBeenCalled();
  });

  it("fails closed when the App identity can't be read", async () => {
    const { deps: d, hostEventDelivery } = deps({
      appIdentity: async () => {
        throw new Error("github_api_unavailable");
      },
    });
    await expect(
      handleGitHubEventIngress(
        { headers: headers({ "x-hub-signature-256": sign(strangerBody) }), rawBody: strangerBody },
        d,
      ),
    ).rejects.toThrow("github_api_unavailable");
    expect(hostEventDelivery.create).not.toHaveBeenCalled();
    expect(routeHostEvent).not.toHaveBeenCalled();
  });

  it("still checks the signature first", async () => {
    const { deps: d } = deps();
    const result = await handleGitHubEventIngress(
      { headers: headers({ "x-hub-signature-256": "sha256=00" }), rawBody: strangerBody },
      d,
    );
    expect(result.status).toBe(401);
  });
});

describe("eventAccount", () => {
  it("reads the installation account for installation events and the repository owner otherwise", () => {
    expect(
      eventAccount("installation_repositories", { action: "added", installation: { id: 3, account: { login: "X" } } }),
    ).toEqual({
      login: "X",
      installationId: 3,
      uninstall: true,
    });
    expect(
      eventAccount("installation", { action: "deleted", installation: { id: 3, account: { login: "X" } } }),
    ).toEqual({
      login: "X",
      installationId: 3,
      uninstall: false,
    });
    expect(eventAccount("issue_comment", { repository: { full_name: "Org/repo" } })).toEqual({
      login: "Org",
      uninstall: false,
    });
    expect(eventAccount("issue_comment", { repository: { owner: { login: "Org" } } })).toEqual({
      login: "Org",
      uninstall: false,
    });
    expect(eventAccount("github_app_authorization", { action: "revoked" })).toBeUndefined();
  });
});
