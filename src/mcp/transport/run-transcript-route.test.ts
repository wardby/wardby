import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "#prisma";
import { buildMcpServer } from "../server.js";
import { startHttpServer, type HttpServerHandle } from "./streamable-http.js";
import { setLogLineFilter } from "../../core/logger.js";
import { RUN_TRANSCRIPT_DOWNLOAD_PATH, type RunTranscriptLinkPayload } from "../tools/run-transcript-download.js";
import { fakeBlobs, fakeTranscriptDb, SESSION_ID, storedTranscript } from "../tools/run-transcript.test-support.js";
import type { AuthProvider } from "../../providers/auth/types.js";

const stored = storedTranscript('{"type":"user"}\n');
let handle: HttpServerHandle | undefined;
const logged: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  setLogLineFilter((line) => line);
  logged.length = 0;
});

async function start(db: PrismaClient) {
  setLogLineFilter((line) => {
    logged.push(line);
    return line;
  });
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const canonicalUri = `http://127.0.0.1:${port}/mcp`;
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri } });
  handle = await startHttpServer({
    mcp,
    config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
    auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
    blobs: fakeBlobs({ "run-transcripts/r1.jsonl.gz": stored.bytes }),
  });
  const token = await mcp.mintRequestState<RunTranscriptLinkPayload>({
    kind: "run-transcript",
    runId: "r1",
    principalId: "trig",
    exp: Date.now() + 60_000,
  });
  return { url: `http://127.0.0.1:${port}${RUN_TRANSCRIPT_DOWNLOAD_PATH}?t=${encodeURIComponent(token)}`, token };
}

const runRow = {
  id: "r1",
  agentId: "a1",
  triggeredById: "trig",
  coding: { provider: "claude-code", repository: "your-org/your-repo", headRef: "wardby/run-r1" },
  transcript: {
    status: "stored",
    sessionId: SESSION_ID,
    blobKey: "run-transcripts/r1.jsonl.gz",
    sha256: stored.sha256,
    expiresAt: new Date(Date.now() + 60_000_000),
  },
};

describe("HTTP transport: run transcript download route", () => {
  it("serves the transcript without an Authorization header, by the signed link alone", async () => {
    const { url } = await start(fakeTranscriptDb([{ id: "a1", ownerId: "owner" }], [runRow]));
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-wardby-sha256")).toBe(stored.sha256);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored.bytes)).toBe(true);
  });

  it("never logs the link token or echoes it in an error, even when the request fails", async () => {
    const failing = fakeTranscriptDb([{ id: "a1", ownerId: "owner" }], [runRow]);
    const { url, token } = await start(failing);
    // Fail inside the handler with an error whose message carries the token, so the
    // transport's 500 path logs an error and answers with a request id.
    (failing.run as unknown as { findUnique: () => Promise<never> }).findUnique = () =>
      Promise.reject(new Error(`database said no for ${token}`));
    const failed = await fetch(url);
    expect(failed.status).toBe(500);
    const failedBody = await failed.text();
    expect(failedBody).not.toContain(token);
    const tampered = await fetch(url.slice(0, -4));
    expect(tampered.status).toBe(403);
    expect(await tampered.text()).toBe(JSON.stringify({ error: "link_invalid" }));
    await handle?.close();
    handle = undefined;
    // pino writes asynchronously; give it a turn to flush through the filter.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(encodeURIComponent(token));
  });
});
