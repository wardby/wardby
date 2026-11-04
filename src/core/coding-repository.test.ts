import { describe, expect, it, vi } from "vitest";
import {
  extraCodingRepositoryLinks,
  RepositoryChoiceRefusedError,
  resolveCodingRepository,
} from "./coding-repository.js";

const profile = { repository: "acme/default", baseRef: "main" };
const links = [
  { repository: "acme/service-a", baseRef: "develop" },
  { repository: "acme/service-b", baseRef: null },
];

function reader(rows = links, runs: Record<string, { repository: string; rootCodingRunId: string | null }> = {}) {
  return {
    agentRepository: { findMany: vi.fn(async () => rows) },
    codingRun: { findUnique: vi.fn(async ({ where }: { where: { runId: string } }) => runs[where.runId] ?? null) },
  };
}
const resolve = (db: ReturnType<typeof reader>, extra = {}) =>
  resolveCodingRepository(db as never, { agentId: "c1", profile, ...extra });

describe("extraCodingRepositoryLinks", () => {
  it("drops a link equal to the default, whatever its spelling", () => {
    const rows = [{ repository: "ACME/Default" }, { repository: "acme/service-a" }];
    expect(extraCodingRepositoryLinks(rows, "acme/default")).toEqual([{ repository: "acme/service-a" }]);
  });
  it("drops a local link equal to a local default", () => {
    const rows = [{ repository: "local:/srv/a/" }, { repository: "local:/srv/b" }];
    expect(extraCodingRepositoryLinks(rows, "local:/srv/a")).toEqual([{ repository: "local:/srv/b" }]);
  });
});

describe("resolveCodingRepository", () => {
  it("uses the default without any query when nothing is asked for", async () => {
    const db = reader();
    await expect(resolve(db)).resolves.toEqual({
      repository: "acme/default",
      baseRef: "main",
      viaRepositoryLink: false,
    });
    expect(db.agentRepository.findMany).not.toHaveBeenCalled();
  });

  it("accepts the default by name without any query", async () => {
    const db = reader();
    await expect(resolve(db, { requested: "ACME/Default" })).resolves.toMatchObject({ viaRepositoryLink: false });
    expect(db.agentRepository.findMany).not.toHaveBeenCalled();
  });

  it("uses a listed repository with the link's base branch", async () => {
    await expect(resolve(reader(), { requested: "Acme/Service-A" })).resolves.toEqual({
      repository: "acme/service-a",
      baseRef: "develop",
      viaRepositoryLink: true,
    });
  });

  it("falls back to the profile's base branch when the link has none", async () => {
    await expect(resolve(reader(), { requested: "acme/service-b" })).resolves.toMatchObject({ baseRef: "main" });
  });

  it("refuses an unlisted repository without echoing it", async () => {
    const error = await resolve(reader(), { requested: "acme/sk-fake-secret" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepositoryChoiceRefusedError);
    expect((error as RepositoryChoiceRefusedError).code).toBe("repository_not_listed");
    expect((error as Error).message).not.toContain("sk-fake-secret");
    expect((error as Error).message).toContain("acme/service-a");
  });

  it("refuses a malformed repository as unlisted", async () => {
    await expect(resolve(reader(), { requested: "../../etc" })).rejects.toMatchObject({
      code: "repository_not_listed",
    });
  });

  it("requires a choice when asked to and the agent has links", async () => {
    await expect(resolve(reader(), { requireExplicit: true })).rejects.toMatchObject({ code: "repository_required" });
  });

  it("uses the default when a choice is required but the agent has no links", async () => {
    await expect(resolve(reader([]), { requireExplicit: true })).resolves.toMatchObject({ repository: "acme/default" });
  });

  it("takes a continuation's repository from its root", async () => {
    const db = reader(links, {
      child: { repository: "acme/service-a", rootCodingRunId: "root" },
      root: { repository: "acme/service-a", rootCodingRunId: null },
    });
    await expect(resolve(db, { continuesCodingRunId: "child", requireExplicit: true })).resolves.toMatchObject({
      repository: "acme/service-a",
      viaRepositoryLink: true,
    });
  });

  describe("a local repository", () => {
    const local = "local:/srv/repos/service";
    const localLinks = [{ repository: local, baseRef: "develop" }];

    it("uses a listed local repository, with its base branch and as a link", async () => {
      await expect(resolve(reader(localLinks), { requested: local })).resolves.toEqual({
        repository: local,
        baseRef: "develop",
        viaRepositoryLink: true,
      });
    });

    it("matches a local path written with a trailing slash or dot segments", async () => {
      await expect(resolve(reader(localLinks), { requested: "local:/srv/repos/./service/" })).resolves.toMatchObject({
        repository: local,
      });
    });

    it("refuses a local path that is not listed, without echoing it", async () => {
      const error = await resolve(reader(localLinks), { requested: "local:/srv/sk-fake-secret" }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "repository_not_listed" });
      expect((error as Error).message).not.toContain("sk-fake-secret");
      expect((error as Error).message).toContain(local);
    });

    it("recognizes a local default without reading links", async () => {
      const db = reader(localLinks);
      const target = await resolveCodingRepository(db as never, {
        agentId: "c1",
        profile: { repository: "local:/srv/repos/main", baseRef: "main" },
        requested: "local:/srv/repos/main/",
      });
      expect(target).toEqual({ repository: "local:/srv/repos/main", baseRef: "main", viaRepositoryLink: false });
      expect(db.agentRepository.findMany).not.toHaveBeenCalled();
    });

    it("takes a continuation's local repository from its root", async () => {
      const db = reader(localLinks, { root: { repository: local, rootCodingRunId: null } });
      await expect(resolve(db, { continuesCodingRunId: "root" })).resolves.toMatchObject({
        repository: local,
        viaRepositoryLink: true,
      });
    });
  });

  describe("a link that equals the default, after update_agent moved the default onto it", () => {
    const redundant = [{ repository: "ACME/Default", baseRef: "develop" }];

    it("does not make a single-repository agent name its repository", async () => {
      await expect(resolve(reader(redundant), { requireExplicit: true })).resolves.toEqual({
        repository: "acme/default",
        baseRef: "main",
        viaRepositoryLink: false,
      });
    });

    it("keeps a follow-up on the default from depending on the redundant link", async () => {
      const db = reader([...redundant, ...links], { root: { repository: "acme/default", rootCodingRunId: null } });
      await expect(resolve(db, { continuesCodingRunId: "root", requireExplicit: true })).resolves.toEqual({
        repository: "acme/default",
        baseRef: "main",
        viaRepositoryLink: false,
      });
    });

    it("lists the default once in a refusal", async () => {
      const error = await resolve(reader([...redundant, ...links]), { requested: "acme/nope" }).catch(
        (e: unknown) => e as RepositoryChoiceRefusedError,
      );
      expect((error as RepositoryChoiceRefusedError).allowed).toEqual([
        "acme/default",
        "acme/service-a",
        "acme/service-b",
      ]);
    });
  });

  it("leaves an unlisted or unknown continuation to checkContinuation, on the default", async () => {
    const db = reader(links, { other: { repository: "acme/elsewhere", rootCodingRunId: null } });
    await expect(resolve(db, { continuesCodingRunId: "other" })).resolves.toMatchObject({ repository: "acme/default" });
    await expect(resolve(db, { continuesCodingRunId: "missing" })).resolves.toMatchObject({
      repository: "acme/default",
    });
  });
});
