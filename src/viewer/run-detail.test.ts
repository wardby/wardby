import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  loadGraphRuns: vi.fn(async () => [{ id: "r1" }]),
}));
import { RunDetailSchema } from "./api-schema.js";
import { loadRunDetail } from "./run-detail.js";

const FAKE_SECRET = "sk-fakefakefakefakefakefakefake0123";

function fakeDb(repositories: unknown[]): PrismaClient {
  return {
    run: {
      findUniqueOrThrow: async () => ({
        agentId: "a1",
        error: null,
        finalText: null,
        stepsDropped: 0,
        taskOverride: null,
        codingRun: {
          request: null,
          provider: "codex",
          repository: "your-org/app",
          baseRef: "main",
          headRef: "wardby/run-r1",
          queuedAt: null,
          failureCategory: null,
          services: [],
          repositories,
        },
      }),
      findMany: async () => [],
    },
    runStep: { findMany: async () => [], count: async () => 0 },
  } as unknown as PrismaClient;
}

describe("loadRunDetail coding.repositories", () => {
  it("lists each repository with its pull request, and nothing else from the stored result", async () => {
    const detail = await loadRunDetail(
      fakeDb([
        {
          name: "app",
          access: "write",
          repository: "your-org/app",
          requestedRef: "main",
          resolvedSha: null,
          pullRequestNumber: 12,
          resultBranch: "wardby/run-r1",
          result: {
            schemaVersion: 1,
            outcome: "no_changes",
            repository: "your-org/app",
            baseRef: "main",
            summary: `leaked ${FAKE_SECRET}`,
            tests: [],
            usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
          },
        },
        {
          name: "upstream",
          access: "read",
          repository: "upstream-org/upstream",
          requestedRef: "v1",
          resolvedSha: "a".repeat(40),
          pullRequestNumber: null,
          resultBranch: null,
          result: null,
        },
      ]),
      "r1",
    );
    expect(detail?.coding?.repositories).toEqual([
      {
        name: "app",
        access: "write",
        repository: "your-org/app",
        requestedRef: "main",
        resolvedSha: null,
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/your-org/app/pull/12",
        resultBranch: "wardby/run-r1",
        outcome: "no_changes",
      },
      {
        name: "upstream",
        access: "read",
        repository: "upstream-org/upstream",
        requestedRef: "v1",
        resolvedSha: "a".repeat(40),
        pullRequestNumber: null,
        pullRequestUrl: null,
        resultBranch: null,
        outcome: null,
      },
    ]);
    expect(JSON.stringify(detail)).not.toContain(FAKE_SECRET);
    expect(
      RunDetailSchema.shape.coding.unwrap().shape.repositories.safeParse(detail?.coding?.repositories).success,
    ).toBe(true);
  });

  it("is an empty list for a single-repository run", async () => {
    expect((await loadRunDetail(fakeDb([]), "r1"))?.coding?.repositories).toEqual([]);
  });
});
