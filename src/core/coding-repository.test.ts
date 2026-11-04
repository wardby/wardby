import { describe, expect, it, vi } from "vitest";
import { RepositoryChoiceRefusedError, resolveCodingRepository } from "./coding-repository.js";

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

  it("leaves an unlisted or unknown continuation to checkContinuation, on the default", async () => {
    const db = reader(links, { other: { repository: "acme/elsewhere", rootCodingRunId: null } });
    await expect(resolve(db, { continuesCodingRunId: "other" })).resolves.toMatchObject({ repository: "acme/default" });
    await expect(resolve(db, { continuesCodingRunId: "missing" })).resolves.toMatchObject({
      repository: "acme/default",
    });
  });
});
