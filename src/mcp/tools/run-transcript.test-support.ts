/**
 * Fakes for the get_run_transcript tool and its download route: a database
 * with runs, agents, grants, coding runs and transcript rows, and an
 * in-memory blob store.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PrismaClient } from "#prisma";
import { BlobStoreError, type BlobStore } from "../../providers/storage/types.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import type { McpRequestContext } from "../context.js";

export const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

export interface FakeTranscriptRun {
  id: string;
  agentId: string;
  triggeredById: string | null;
  coding?: {
    provider: string;
    repository: string;
    headRef: string;
    resultBranch?: string | null;
    baseSha?: string | null;
  } | null;
  transcript?: {
    status: string;
    reason?: string | null;
    sessionId?: string | null;
    blobKey?: string | null;
    sizeBytes?: number | null;
    sha256?: string | null;
    expiresAt: Date;
    provider?: string;
  } | null;
}

export function fakeTranscriptDb(
  agents: { id: string; ownerId: string | null }[],
  runs: FakeTranscriptRun[],
  grants: FakeGrantSeed[] = [],
): PrismaClient {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const runRows = new Map(runs.map((r) => [r.id, r]));
  return {
    resourceGrant: fakeResourceGrants(grants),
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
      findMany: async () => [],
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const run = runRows.get(where.id);
        return run ? { id: run.id, agentId: run.agentId, triggeredById: run.triggeredById, status: "succeeded" } : null;
      },
    },
    codingRun: {
      findUnique: async ({ where }: { where: { runId: string } }) => {
        const coding = runRows.get(where.runId)?.coding;
        return coding ? { resultBranch: null, baseSha: null, ...coding } : null;
      },
    },
    runTranscript: {
      findUnique: async ({ where }: { where: { runId: string } }) => {
        const row = runRows.get(where.runId)?.transcript;
        return row
          ? {
              runId: where.runId,
              provider: "claude-code",
              reason: null,
              sessionId: null,
              blobKey: null,
              sizeBytes: null,
              sha256: null,
              createdAt: new Date(0),
              ...row,
            }
          : null;
      },
    },
  } as unknown as PrismaClient;
}

export function fakeBlobs(objects: Record<string, Buffer> = {}): BlobStore & { objects: Map<string, Buffer> } {
  const store = new Map(Object.entries(objects));
  return {
    objects: store,
    put: async (key, body) => void store.set(key, body),
    get: async (key) => {
      const body = store.get(key);
      if (!body) throw new BlobStoreError("not_found");
      return body;
    },
    delete: async (key) => void store.delete(key),
    signedUrl: async () => {
      throw new BlobStoreError("not_supported");
    },
    putStream: async () => {
      throw new BlobStoreError("not_supported");
    },
    getStream: async () => {
      throw new BlobStoreError("not_supported");
    },
    head: async () => null,
  };
}

/** A stored transcript object: the wardby header line, then `body`, gzip-compressed. */
export function storedTranscript(body: string, sessionId = SESSION_ID): { bytes: Buffer; sha256: string } {
  const header = JSON.stringify({
    type: "wardby-transcript",
    version: 1,
    provider: "claude-code",
    sessionId,
    status: "ok",
  });
  const bytes = gzipSync(Buffer.from(`${header}\n${body}`));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function fakeCtx(db: PrismaClient, principalId: string, operator = false): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(["agents:read"]),
    canonicalUri: "https://host/mcp",
    providers: {} as McpRequestContext["providers"],
    db,
    clientSupportsTasks: false,
    ...(operator ? { operator: true } : {}),
    mcpReq: { requestState: () => undefined },
  };
}
