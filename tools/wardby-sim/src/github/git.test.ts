import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitVersionOk } from "./git-store.js";
import { GITHUB_GIT_PREFIX } from "./git.js";
import { githubHarness, REPO, type Harness } from "./harness.test-support.js";

function git(cwd: string, args: string[], token?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const auth = token
    ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]
    : [];
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        ...auth,
        "-c",
        "user.name=Sim",
        "-c",
        "user.email=sim@example.invalid",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: tmpdir(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

let h: Harness;
let url: string;
let work: string;
beforeEach(async () => {
  h = await githubHarness();
  url = `${await h.sim.listen()}${GITHUB_GIT_PREFIX}/${REPO}.git`;
  work = mkdtempSync(join(tmpdir(), "wardby-sim-git-test-"));
});
afterEach(async () => {
  rmSync(work, { recursive: true, force: true });
  h.gh.git.dispose();
  await h.sim.close();
});

describe("GitHub sim git smart HTTP", () => {
  it("runs on git >= 2.38", async () => {
    expect(await gitVersionOk()).toBe(true);
  });

  it("clones and pushes with a live installation token; a push moves the PR head and fires push + synchronize", async () => {
    await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "b\n" } },
      { action: "github.pull", repo: REPO, head: "feature", title: "Feature", author: "acme" },
      {
        action: "github.webhook_subscribe",
        url: "http://127.0.0.1:9/never",
        secret: "s",
        events: ["push", "pull_request"],
      },
      { action: "github.webhook_pause" },
    ]);
    const token = await h.mint({ contents: "write", pull_requests: "write" });
    const cloned = await git(work, ["clone", url, "repo"], token);
    expect(cloned.code, cloned.stderr).toBe(0);
    const repo = join(work, "repo");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# widgets\n");
    expect((await git(repo, ["checkout", "feature"])).code).toBe(0);
    writeFileSync(join(repo, "b.txt"), "pushed\n");
    await git(repo, ["commit", "-am", "push from a clone"]);
    const pushed = await git(repo, ["push", "origin", "feature"], token);
    expect(pushed.code, pushed.stderr).toBe(0);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await h.gh.git.resolve(REPO, "feature")).toBe(head);
    const pr = await h.call("GET", `/repos/${REPO}/pulls/1`, undefined, { token });
    expect(pr.body.head.sha).toBe(head);
    const events =
      h.gh.webhooks.length > 0 ? (await h.script([{ action: "github.webhook_deliveries" }]))[0] : undefined;
    const kinds = (events as { deliveries: { event: string; action: string | null }[] }).deliveries.map(
      (d) => `${d.event}.${d.action ?? ""}`,
    );
    expect(kinds.slice(-2)).toEqual(["push.", "pull_request.synchronize"]);
    // A new branch pushed from the clone.
    await git(repo, ["checkout", "-b", "wardby/run-x"]);
    writeFileSync(join(repo, "c.txt"), "c\n");
    await git(repo, ["add", "c.txt"]);
    await git(repo, ["commit", "-m", "new branch"]);
    expect((await git(repo, ["push", "origin", "wardby/run-x"], token)).code).toBe(0);
    expect(await h.gh.git.resolve(REPO, "refs/heads/wardby/run-x")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a missing, expired or revoked token (401)", async () => {
    expect((await git(work, ["clone", url, "a"])).code).not.toBe(0);
    const token = await h.mint({ contents: "read" });
    await h.call("DELETE", "/installation/token", undefined, { token });
    const revoked = await git(work, ["clone", url, "b"], token);
    expect(revoked.code).not.toBe(0);
    const second = await h.mint({ contents: "read" });
    await h.script([{ action: "github.clock", offsetMs: 61 * 60_000 }]);
    expect((await git(work, ["clone", url, "c"], second)).code).not.toBe(0);
    const statuses = h.sim.state.calls.list({ service: "github-git" }).map((c) => c.status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(JSON.stringify(h.sim.state.calls.list())).not.toContain(second);
  });

  it("refuses a push with a read-only token (403) and a repository outside the token (404)", async () => {
    const read = await h.mint({ contents: "read" });
    expect((await git(work, ["clone", url, "repo"], read)).code).toBe(0);
    const repo = join(work, "repo");
    writeFileSync(join(repo, "x.txt"), "x\n");
    await git(repo, ["add", "x.txt"]);
    await git(repo, ["commit", "-m", "x"]);
    expect((await git(repo, ["push", "origin", "main"], read)).code).not.toBe(0);
    expect(h.sim.state.calls.list({ service: "github-git" }).some((c) => c.status === 403)).toBe(true);
    const noContents = await h.mint({ pull_requests: "read" });
    expect((await git(work, ["clone", url, "other"], noContents)).code).not.toBe(0);
    await h.script([{ action: "github.repo", repo: "acme/secret" }]);
    const secretUrl = url.replace("widgets", "secret");
    expect((await git(work, ["clone", secretUrl, "secret"], read)).code).not.toBe(0);
    expect(h.sim.state.calls.list({ service: "github-git" }).some((c) => c.status === 404)).toBe(true);
  });
});
