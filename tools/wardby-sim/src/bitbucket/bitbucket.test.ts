import { describe, expect, it } from "vitest";
import { createSimServer, simRequest } from "../server.js";
import { createBitbucketSim, BITBUCKET_API_PREFIX } from "./service.js";
import { SIM_BITBUCKET_REPO_TOKEN, SIM_BITBUCKET_WORKSPACE_TOKEN } from "./state.js";

function harness() {
  const bitbucket = createBitbucketSim();
  const sim = createSimServer({ services: [bitbucket.service] });
  const call = async (path: string, token?: string) => {
    const response = await sim.dispatch(
      simRequest("GET", `${BITBUCKET_API_PREFIX}${path}`, undefined, token ? { authorization: `Bearer ${token}` } : {}),
    );
    const body = String(response.body ?? "");
    return { status: response.status, headers: response.headers ?? {}, body };
  };
  const state = bitbucket.state;
  state.addRepo("acme/web", { files: { "README.md": "hello", "src/a.ts": "export {};" } });
  state.addPullRequest("acme/web", {
    id: 4,
    title: "T",
    author: "acct-1",
    headRef: "feature",
    headSha: "abc123",
    baseRef: "main",
  });
  return { call, state };
}

const REPO = "/2.0/repositories/acme/web";

describe("simulated Bitbucket", () => {
  it("needs a token, and keeps a repository token to its repository", async () => {
    const { call } = harness();
    expect((await call(`${REPO}/pullrequests/4`)).status).toBe(401);
    expect((await call(`${REPO}/pullrequests/4`, "nope")).status).toBe(401);
    expect((await call(`${REPO}/pullrequests/4`, SIM_BITBUCKET_REPO_TOKEN)).status).toBe(200);
    expect((await call("/2.0/repositories/acme/other/pullrequests/4", SIM_BITBUCKET_REPO_TOKEN)).status).toBe(403);
  });

  it("serves a pull request in Bitbucket's shape", async () => {
    const { call } = harness();
    const body = JSON.parse((await call(`${REPO}/pullrequests/4`, SIM_BITBUCKET_REPO_TOKEN)).body);
    expect(body.id).toBe(4);
    expect(body.source.branch.name).toBe("feature");
    expect(body.source.commit.hash).toBe("abc123");
    expect(body.destination.branch.name).toBe("main");
    expect(body.author.account_id).toBe("acct-1");
    expect(body.links.html.href).toContain("/acme/web/pull-requests/4");
  });

  it("redirects a diff, as a tool must follow itself", async () => {
    const { call } = harness();
    const first = await call(`${REPO}/pullrequests/4/diff`, SIM_BITBUCKET_REPO_TOKEN);
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain("/diff/");
    const second = await call(
      new URL(first.headers.location, "https://x").pathname.replace(/^.*\/2\.0/, "/2.0"),
      SIM_BITBUCKET_REPO_TOKEN,
    );
    expect(second.status).toBe(200);
  });

  it("reads files and directories at a commit", async () => {
    const { call } = harness();
    expect((await call(`${REPO}/src/abc123/README.md`, SIM_BITBUCKET_REPO_TOKEN)).body).toBe("hello");
    const dir = JSON.parse((await call(`${REPO}/src/abc123/src`, SIM_BITBUCKET_REPO_TOKEN)).body);
    expect(dir.values[0].path).toBe("src/a.ts");
    expect(dir.values[0].type).toBe("commit_file");
    expect((await call(`${REPO}/src/abc123/nope`, SIM_BITBUCKET_REPO_TOKEN)).status).toBe(404);
  });

  it("finds a pull request by source branch", async () => {
    const { call } = harness();
    const q = encodeURIComponent('source.branch.name="feature"');
    const body = JSON.parse((await call(`${REPO}/pullrequests?q=${q}`, SIM_BITBUCKET_REPO_TOKEN)).body);
    expect(body.values.map((p: { id: number }) => p.id)).toEqual([4]);
    const none = encodeURIComponent('source.branch.name="other"');
    expect(JSON.parse((await call(`${REPO}/pullrequests?q=${none}`, SIM_BITBUCKET_REPO_TOKEN)).body).values).toEqual(
      [],
    );
  });

  describe("the permission endpoint", () => {
    const path = (account: string) =>
      `/2.0/workspaces/acme/permissions/repositories/web?q=${encodeURIComponent(`user.account_id="${account}"`)}`;

    it("answers a workspace token, and refuses a repository token", async () => {
      const { call, state } = harness();
      state.setPermission("acme/web", "acct-1", "write");
      expect((await call(path("acct-1"), SIM_BITBUCKET_REPO_TOKEN)).status).toBe(403);
      const body = JSON.parse((await call(path("acct-1"), SIM_BITBUCKET_WORKSPACE_TOKEN)).body);
      expect(body.values).toEqual([
        {
          permission: "write",
          type: "repository_permission",
          user: { account_id: "acct-1" },
          repository: { full_name: "acme/web" },
        },
      ]);
    });

    it("returns nothing for someone without access", async () => {
      const { call } = harness();
      const body = JSON.parse((await call(path("acct-2"), SIM_BITBUCKET_WORKSPACE_TOKEN)).body);
      expect(body.values).toEqual([]);
    });
  });

  it("forgets everything on reset", () => {
    const { state } = harness();
    state.reset();
    expect(state.repo("acme/web")).toBeUndefined();
  });
});
