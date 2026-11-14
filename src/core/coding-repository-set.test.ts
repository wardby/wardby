import { describe, expect, it, vi } from "vitest";
import {
  RepositoryRefUnreadableError,
  RepositorySetRefusedError,
  parseRefFile,
  planRepositorySet,
  resolveRepositorySetRefs,
  type RepositorySetLink,
} from "./coding-repository-set.js";

const at = (n: number) => new Date(2026, 0, n);
const link = (over: Partial<RepositorySetLink>): RepositorySetLink => ({
  id: over.name ?? "l",
  name: "x",
  provider: "github",
  repository: "upstream-org/upstream",
  access: "read",
  baseRef: null,
  ref: "main",
  refFromFile: null,
  inDefaultSet: false,
  asRemote: false,
  createdAt: at(1),
  ...over,
});
const links = [
  link({ id: "l1", name: "base", refFromFile: "upstream-sync", ref: null, inDefaultSet: true, createdAt: at(1) }),
  link({ id: "l2", name: "upstream", ref: "main", inDefaultSet: true, createdAt: at(2) }),
  link({ id: "l3", name: "tools", access: "write", repository: "your-org/tools", ref: null, createdAt: at(3) }),
];
const workspace = { provider: "github", repository: "your-org/your-fork" };

describe("planRepositorySet", () => {
  it("is the default set, in link order", () => {
    const plan = planRepositorySet({ links, workspace, limit: 5, profileBaseRef: "main", historyOn: false });
    expect(plan.map((p) => [p.position, p.name, p.access, p.requestedRef, p.refFromFile])).toEqual([
      [0, "base", "read", null, "upstream-sync"],
      [1, "upstream", "read", "main", null],
    ]);
  });
  it("is replaced by a per-run list, in the list's order; [] is the default repository only", () => {
    expect(
      planRepositorySet({
        links,
        workspace,
        requested: ["tools", "upstream"],
        limit: 5,
        profileBaseRef: "main",
        historyOn: false,
      }).map((p) => [p.name, p.baseRef]),
    ).toEqual([
      ["tools", "main"],
      ["upstream", null],
    ]);
    expect(
      planRepositorySet({ links, workspace, requested: [], limit: 5, profileBaseRef: "main", historyOn: false }),
    ).toEqual([]);
  });
  it("refuses an unknown name without echoing it", () => {
    const run = () =>
      planRepositorySet({
        links,
        workspace,
        requested: ["sk-ant-FAKEsecret0123456789abcdef"],
        limit: 5,
        profileBaseRef: "main",
        historyOn: false,
      });
    expect(run).toThrow(RepositorySetRefusedError);
    expect(run).toThrow(/^repository_not_listed: .*base, upstream, tools/);
    expect(run).not.toThrow(/FAKEsecret/);
  });
  it("refuses a duplicate name and a set over the limit", () => {
    expect(() =>
      planRepositorySet({
        links,
        workspace,
        requested: ["base", "base"],
        limit: 5,
        profileBaseRef: "main",
        historyOn: false,
      }),
    ).toThrow(/^invalid_repositories:/);
    expect(() =>
      planRepositorySet({
        links,
        workspace,
        requested: ["base", "upstream", "tools"],
        limit: 3,
        profileBaseRef: "main",
        historyOn: false,
      }),
    ).toThrow(/^repository_set_too_large:/);
  });
  it("skips the write link that is the run's /workspace (the repository argument chose it)", () => {
    const plan = planRepositorySet({
      links,
      workspace: { provider: "github", repository: "your-org/tools" },
      requested: ["tools", "base"],
      limit: 5,
      profileBaseRef: "main",
      historyOn: false,
    });
    expect(plan.map((p) => p.name)).toEqual(["base"]);
  });
});

describe("parseRefFile", () => {
  it.each([
    [null, { ok: false, reason: "missing" }],
    ["  \n", { ok: false, reason: "empty" }],
    ["a".repeat(256), { ok: false, reason: "too_long" }],
    ["two\nlines", { ok: false, reason: "invalid" }],
    ["not a ref", { ok: false, reason: "invalid" }],
    [`${"b".repeat(40)}\n`, { ok: true, ref: "b".repeat(40) }],
  ])("%j", (text, expected) => expect(parseRefFile(text)).toEqual(expected));
});

describe("resolveRepositorySetRefs", () => {
  const planned = planRepositorySet({ links, workspace, limit: 5, profileBaseRef: "main", historyOn: false });
  it("reads fromFile at the default repository's baseRef, then resolves every ref to a SHA", async () => {
    const readFile = vi.fn(async () => `${"c".repeat(40)}\n`);
    const resolveRef = vi.fn(async ({ ref }: { ref: string }) => (ref === "main" ? "d".repeat(40) : ref));
    const resolved = await resolveRepositorySetRefs(planned, {
      workspace: { repository: "your-org/your-fork", baseRef: "main" },
      readFile,
      resolveRef,
    });
    expect(readFile).toHaveBeenCalledWith({
      repository: "your-org/your-fork",
      baseRef: "main",
      path: "upstream-sync",
      maxBytes: 1024,
    });
    expect(resolved.map((r) => [r.name, r.requestedRef, r.resolvedSha])).toEqual([
      ["base", "c".repeat(40), "c".repeat(40)],
      ["upstream", "main", "d".repeat(40)],
    ]);
  });
  it.each(["../secrets", "/etc/upstream-sync", "a/../../b"])(
    "refuses a ref file path outside the repository (%s) without reading it",
    async (refFromFile) => {
      const readFile = vi.fn(async () => `${"c".repeat(40)}\n`);
      const resolveRef = vi.fn(async () => "d".repeat(40));
      const err = await resolveRepositorySetRefs(
        planned.map((row) => (row.name === "base" ? { ...row, refFromFile } : row)),
        { workspace: { repository: "your-org/your-fork", baseRef: "main" }, readFile, resolveRef },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepositoryRefUnreadableError);
      expect((err as Error).message).toBe(
        'repository_ref_unreadable: the ref file for link "base" is not a repository-relative file path.',
      );
      expect(readFile).not.toHaveBeenCalled();
      expect(resolveRef).not.toHaveBeenCalled();
    },
  );
  it("refuses an unreadable ref file naming the link and path, never its content (secrets rule)", async () => {
    const secret = "ghs_FAKEtoken0123456789abcdefABCDEF";
    const err = await resolveRepositorySetRefs(planned, {
      workspace: { repository: "your-org/your-fork", baseRef: "main" },
      readFile: async () => `${secret} trailing`,
      resolveRef: async () => "e".repeat(40),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryRefUnreadableError);
    expect((err as Error).message).toBe(
      'repository_ref_unreadable: the ref file upstream-sync for link "base" is not a branch, a tag or a 40-hex commit SHA.',
    );
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String((err as Error).stack)).not.toContain(secret);
  });
  it("refuses a ref-file ref the host cannot find, naming the path only (secrets rule)", async () => {
    // A token-shaped string is a valid branch name, so it parses and then fails to resolve.
    const secret = "ghs_FAKEtoken0123456789abcdefABCDEF";
    const err = await resolveRepositorySetRefs(planned, {
      workspace: { repository: "your-org/your-fork", baseRef: "main" },
      readFile: async () => secret,
      resolveRef: async () => null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryRefUnreadableError);
    expect((err as Error).message).toBe(
      'repository_ref_unreadable: the ref file upstream-sync for link "base" names a ref that does not exist.',
    );
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(String((err as Error).stack)).not.toContain(secret);
  });
  it("names a link's own ref when the host cannot find it", async () => {
    const own = planRepositorySet({ links: [links[1]], workspace, limit: 5, profileBaseRef: "main", historyOn: false });
    await expect(
      resolveRepositorySetRefs(own, {
        workspace: { repository: "your-org/your-fork", baseRef: "main" },
        readFile: async () => null,
        resolveRef: async () => null,
      }),
    ).rejects.toThrow('repository_ref_unreadable: link "upstream" names ref main and it does not exist.');
  });
  it("wraps a host error as unavailable instead of letting it escape", async () => {
    const own = planRepositorySet({ links: [links[1]], workspace, limit: 5, profileBaseRef: "main", historyOn: false });
    const err = await resolveRepositorySetRefs(own, {
      workspace: { repository: "your-org/your-fork", baseRef: "main" },
      readFile: async () => null,
      resolveRef: async () => {
        throw new Error("github_rate_limited");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryRefUnreadableError);
    expect((err as Error).message).toBe(
      'repository_ref_unreadable: link "upstream": its ref could not be resolved right now.',
    );
  });
  it("maps a too-large ref file to too_long", async () => {
    await expect(
      resolveRepositorySetRefs(planned, {
        workspace: { repository: "your-org/your-fork", baseRef: "main" },
        readFile: async () => {
          throw new Error("github_file_too_large");
        },
        resolveRef: async () => "e".repeat(40),
      }),
    ).rejects.toThrow(
      'repository_ref_unreadable: the ref file upstream-sync for link "base" is longer than 255 bytes.',
    );
  });
});

describe("planRepositorySet remote links (#536)", () => {
  const remote = link({ id: "r1", name: "upstream", inDefaultSet: true, asRemote: true });
  const plan = (over: { historyOn: boolean; workspace?: { provider: string; repository: string } }) =>
    planRepositorySet({
      links: [remote],
      workspace: over.workspace ?? workspace,
      limit: 5,
      profileBaseRef: "main",
      historyOn: over.historyOn,
    });

  it("carries asRemote to the planned row when history is on", () => {
    expect(plan({ historyOn: true }).map((r) => [r.name, r.asRemote])).toEqual([["upstream", true]]);
  });
  it("refuses a remote link while history is off", () => {
    expect(() => plan({ historyOn: false })).toThrow(/^repository_remote_needs_history:/);
  });
  it("refuses a remote link on another host than the default repository", () => {
    expect(() => plan({ historyOn: true, workspace: { provider: "local", repository: "/srv/repo" } })).toThrow(
      /^repository_remote_invalid:/,
    );
  });
});
