import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRunTranscriptTool } from "./run-transcript.js";
import { registerRunTools } from "./runs.js";
import {
  handleRunTranscriptDownload,
  RUN_TRANSCRIPT_DOWNLOAD_PATH,
  TRANSCRIPT_META_HEADER,
  TRANSCRIPT_SESSION_HEADER,
  TRANSCRIPT_SHA256_HEADER,
  type RunTranscriptLinkPayload,
} from "./run-transcript-download.js";
import { createStdioLinkHost } from "../transport/stdio-link-host.js";
import { handleSecretElicitationForm } from "./secret-elicitation-form.js";
import {
  fakeBlobs,
  fakeCtx,
  fakeTranscriptDb,
  SESSION_ID,
  storedTranscript,
  type FakeTranscriptRun,
} from "./run-transcript.test-support.js";
import type { PrismaClient } from "#prisma";

const CANONICAL_URI = "https://host/mcp";
const DAY = 24 * 60 * 60 * 1000;
const BODY = '{"type":"user","message":{"role":"user","content":"hello"}}\n';
const stored = storedTranscript(BODY);

function storedRun(overrides: Partial<FakeTranscriptRun> = {}): FakeTranscriptRun {
  return {
    id: "r1",
    agentId: "a1",
    triggeredById: "trig",
    coding: {
      provider: "claude-code",
      repository: "your-org/your-repo",
      headRef: "wardby/run-r1",
      baseSha: "abc123",
    },
    transcript: {
      status: "stored",
      sessionId: SESSION_ID,
      blobKey: "run-transcripts/r1.jsonl.gz",
      sizeBytes: stored.bytes.byteLength,
      sha256: stored.sha256,
      expiresAt: new Date(Date.now() + 30 * DAY),
    },
    ...overrides,
  };
}

const AGENTS = [{ id: "a1", ownerId: "owner" }];

async function setup(
  db: PrismaClient,
  principalId: string,
  opts: { operator?: boolean; blobs?: boolean; audience?: "stdio" | "http" } = {},
) {
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, principalId, opts.operator));
  registerRunTools(mcp);
  const tokens: string[] = [];
  registerRunTranscriptTool(mcp, {
    downloadUrl: async (token) => {
      tokens.push(token);
      return `https://host${RUN_TRANSCRIPT_DOWNLOAD_PATH}?t=${encodeURIComponent(token)}`;
    },
    blobStoreConfigured: opts.blobs ?? true,
    audience: opts.audience ?? (opts.operator ? "stdio" : "http"),
  });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (runId: string) => {
    const result = (await client.callTool({ name: "get_run_transcript", arguments: { runId } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0].text };
  };
  return { mcp, call, tokens };
}

describe("get_run_transcript", () => {
  it("gives the triggerer a link and the resume command, never the transcript", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { call, tokens } = await setup(db, "trig");
    const result = await call("r1");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text) as Record<string, unknown> & { download: { url: string } };
    expect(body).toMatchObject({
      runId: "r1",
      status: "stored",
      sessionId: SESSION_ID,
      provider: "claude-code",
      repository: "your-org/your-repo",
      branch: "wardby/run-r1",
      baseSha: "abc123",
      sizeBytes: stored.bytes.byteLength,
    });
    expect(tokens).toHaveLength(1);
    expect(body.download.url).toContain(encodeURIComponent(tokens[0]));
    // The command reads the link from stdin, so it stays out of shell history and the process list.
    expect(body.command).toBe("npx @wardby/cli@latest resume -");
    expect(body.command).not.toContain(tokens[0]);
    expect(result.text).not.toContain("hello");
  });

  it("gives the agent's owner a link; refuses another user as not found", async () => {
    const db = fakeTranscriptDb(
      AGENTS,
      [storedRun()],
      [{ resourceType: "agent", resourceId: "a1", level: "execute", principalId: "reader" }],
    );
    expect((await (await setup(db, "owner")).call("r1")).isError).toBe(false);
    const other = await (await setup(db, "reader")).call("r1");
    expect(other.isError).toBe(true);
    expect(other.text).toContain('Run "r1" not found');
    // Same answer as a run that does not exist.
    expect((await (await setup(db, "reader")).call("nope")).text).toContain('Run "nope" not found');
  });

  it.each([
    ["too_large", null],
    ["not_captured", "no_blob_store"],
    ["failed", "secrets_unavailable"],
  ])("reports status %s with its reason and no link", async (status, reason) => {
    const db = fakeTranscriptDb(AGENTS, [
      storedRun({ transcript: { status, reason, expiresAt: new Date(Date.now() + DAY) } }),
    ]);
    const { call, tokens } = await setup(db, "trig");
    const body = JSON.parse((await call("r1")).text) as Record<string, unknown>;
    expect(body.status).toBe(status);
    if (reason) expect(body.reason).toBe(reason);
    expect(body.meaning).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("download");
    expect(tokens).toHaveLength(0);
  });

  it("reports none, expired, unavailable and unsupported without a link", async () => {
    const cases: [FakeTranscriptRun, string, string?][] = [
      [storedRun({ transcript: null }), "none"],
      [storedRun({ transcript: { ...storedRun().transcript!, expiresAt: new Date(Date.now() - 1000) } }), "expired"],
      [
        storedRun({ coding: { provider: "codex", repository: "your-org/your-repo", headRef: "b" } }),
        "unsupported",
        "provider_unsupported",
      ],
      [storedRun({ coding: null }), "unsupported", "not_a_coding_run"],
    ];
    for (const [run, status, reason] of cases) {
      const { call, tokens } = await setup(fakeTranscriptDb(AGENTS, [run]), "trig");
      const body = JSON.parse((await call("r1")).text) as Record<string, unknown>;
      expect(body.status).toBe(status);
      if (reason) expect(body.reason).toBe(reason);
      expect(tokens).toHaveLength(0);
    }
    const noBlobs = await setup(fakeTranscriptDb(AGENTS, [storedRun()]), "trig", { blobs: false });
    expect(JSON.parse((await noBlobs.call("r1")).text)).toMatchObject({
      status: "unavailable",
      reason: "no_blob_store",
    });
  });

  it("uses the result branch when the run pushed to a local repository", async () => {
    const db = fakeTranscriptDb(AGENTS, [
      storedRun({
        coding: { provider: "claude-code", repository: "local:/src/app", headRef: "main", resultBranch: "wardby/x" },
      }),
    ]);
    const body = JSON.parse((await (await setup(db, "trig")).call("r1")).text) as Record<string, unknown>;
    expect(body.branch).toBe("wardby/x");
  });
});

/** A minimal ServerResponse that records what was written. */
function captureResponse() {
  const out: { status?: number; headers: Record<string, string>; body: Buffer } = {
    headers: {},
    body: Buffer.alloc(0),
  };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v;
      this.headersSent = true;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      return this;
    },
  };
  return { res: res as unknown as import("node:http").ServerResponse, out };
}

describe("run transcript download", () => {
  const blobs = () => fakeBlobs({ "run-transcripts/r1.jsonl.gz": stored.bytes });

  async function mintFor(db: PrismaClient, principalId: string, operator = false) {
    const { call, mcp, tokens } = await setup(db, principalId, { operator });
    await call("r1");
    return { mcp, token: tokens[0] };
  }

  async function download(
    mcp: Awaited<ReturnType<typeof setup>>["mcp"],
    db: PrismaClient,
    token: string | null,
    store = blobs(),
    now?: () => Date,
    audience: "stdio" | "http" = "http",
  ) {
    const { res, out } = captureResponse();
    await handleRunTranscriptDownload("GET", token, res, {
      verify: (t) => mcp.verifyRequestState(t),
      audience,
      db,
      blobs: store,
      now,
    });
    return out;
  }

  it("serves the stored gzip bytes with the sha and session headers and the checkout metadata", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp, token } = await mintFor(db, "trig");
    const out = await download(mcp, db, token);
    expect(out.status).toBe(200);
    expect(out.body.equals(stored.bytes)).toBe(true);
    expect(gunzipSync(out.body).toString()).toContain(BODY);
    expect(out.headers[TRANSCRIPT_SHA256_HEADER]).toBe(stored.sha256);
    expect(out.headers[TRANSCRIPT_SESSION_HEADER]).toBe(SESSION_ID);
    expect(out.headers["cache-control"]).toBe("no-store");
    const meta = JSON.parse(Buffer.from(out.headers[TRANSCRIPT_META_HEADER], "base64url").toString()) as unknown;
    expect(meta).toEqual({
      runId: "r1",
      sessionId: SESSION_ID,
      provider: "claude-code",
      repository: "your-org/your-repo",
      headRef: "wardby/run-r1",
      resultBranch: null,
      baseSha: "abc123",
      sha256: stored.sha256,
    });
  });

  it("works for the stdio operator's link", async () => {
    const db = fakeTranscriptDb([{ id: "a1", ownerId: null }], [storedRun({ triggeredById: null })]);
    const { mcp, token } = await mintFor(db, "local", true);
    expect((await download(mcp, db, token, blobs(), undefined, "stdio")).status).toBe(200);
  });

  it("serves a link only on the host it was minted for; the HTTP route never takes an operator link", async () => {
    const db = fakeTranscriptDb([{ id: "a1", ownerId: null }], [storedRun({ triggeredById: null })]);
    // A stdio operator link, signed with a key the HTTP host shares (REQUEST_STATE_KEY).
    const { mcp, token } = await mintFor(db, "local", true);
    const onHttp = await download(mcp, db, token, blobs(), undefined, "http");
    expect(onHttp.status).toBe(403);
    expect(JSON.parse(onHttp.body.toString())).toEqual({ error: "link_invalid" });
    // An HTTP-audience payload claiming the operator flag is refused everywhere.
    const forged = await mcp.mintRequestState({
      kind: "run-transcript",
      aud: "http",
      runId: "r1",
      principalId: "local",
      operator: true,
      exp: Date.now() + 60_000,
    });
    expect((await download(mcp, db, forged, blobs(), undefined, "http")).status).toBe(403);
    // An HTTP link is not served by the stdio host either.
    const httpLink = await mcp.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "http",
      runId: "r1",
      principalId: "trig",
      exp: Date.now() + 60_000,
    });
    const owned = fakeTranscriptDb(AGENTS, [storedRun()]);
    expect((await download(mcp, owned, httpLink, blobs(), undefined, "http")).status).toBe(200);
    expect((await download(mcp, owned, httpLink, blobs(), undefined, "stdio")).status).toBe(403);
  });

  it("refuses a missing, tampered, foreign or expired token with no content", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp, token } = await mintFor(db, "trig");
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    const forged = await mcp.mintRequestState({ kind: "create", ownerId: "trig", secretName: "X" });
    const expired = await mcp.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "http",
      runId: "r1",
      principalId: "trig",
      exp: Date.now() - 1,
    });
    const otherServer = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
    const otherKey = await otherServer.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "http",
      runId: "r1",
      principalId: "trig",
      exp: Date.now() + 60_000,
    });
    for (const bad of [null, "", "garbage", tampered, forged, expired, otherKey]) {
      const out = await download(mcp, db, bad);
      expect(out.status).toBe(403);
      expect(JSON.parse(out.body.toString())).toEqual({ error: "link_invalid" });
    }
    // Past its own expiry even though the codec would still accept it.
    const later = await download(mcp, db, token, blobs(), () => new Date(Date.now() + 11 * 60_000));
    expect(later.status).toBe(403);
  });

  it("refuses a link for a run the principal cannot read (other user, lost access, other run)", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun(), storedRun({ id: "r2", triggeredById: "someone" })]);
    const { mcp } = await mintFor(db, "trig");
    const otherUser = await mcp.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "http",
      runId: "r1",
      principalId: "stranger",
      exp: Date.now() + 60_000,
    });
    const otherRun = await mcp.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "http",
      runId: "r2",
      principalId: "trig",
      exp: Date.now() + 60_000,
    });
    for (const token of [otherUser, otherRun]) {
      const out = await download(mcp, db, token);
      expect(out.status).toBe(404);
      expect(JSON.parse(out.body.toString())).toEqual({ error: "not_found" });
    }
    // The owner's link stops working once ownership moves.
    const owned = await mintFor(db, "owner");
    const moved = fakeTranscriptDb([{ id: "a1", ownerId: "new-owner" }], [storedRun()]);
    expect((await download(owned.mcp, moved, owned.token)).status).toBe(404);
  });

  it("refuses a transcript that expired, is not stored, is missing or no longer matches its hash", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp, token } = await mintFor(db, "trig");
    const expiredRow = fakeTranscriptDb(AGENTS, [
      storedRun({ transcript: { ...storedRun().transcript!, expiresAt: new Date(Date.now() - 1) } }),
    ]);
    expect((await download(mcp, expiredRow, token)).status).toBe(410);
    const failedRow = fakeTranscriptDb(AGENTS, [
      storedRun({ transcript: { status: "failed", expiresAt: new Date(Date.now() + DAY) } }),
    ]);
    expect((await download(mcp, failedRow, token)).status).toBe(404);
    expect((await download(mcp, db, token, fakeBlobs())).status).toBe(503);
    const corrupt = fakeBlobs({ "run-transcripts/r1.jsonl.gz": Buffer.from("not the stored bytes") });
    const out = await download(mcp, db, token, corrupt);
    expect(out.status).toBe(500);
    expect(JSON.parse(out.body.toString())).toEqual({ error: "transcript_corrupt" });
  });

  it("answers only GET", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp, token } = await mintFor(db, "trig");
    const { res, out } = captureResponse();
    await handleRunTranscriptDownload("POST", token, res, {
      verify: (t) => mcp.verifyRequestState(t),
      audience: "http",
      db,
      blobs: blobs(),
    });
    expect(out.status).toBe(405);
  });

  it("a transcript link does not open the secret form", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp, token } = await mintFor(db, "trig");
    const { res, out } = captureResponse();
    await handleSecretElicitationForm("GET", token, () => Promise.resolve(new URLSearchParams()), res, {
      verify: (t) => mcp.verifyRequestState(t),
      secrets: {} as never,
      db,
    });
    expect(out.status).toBe(400);
    expect(out.body.toString()).toMatch(/expired|invalid/i);
  });
});

describe("stdio link host", () => {
  it("serves the transcript download over loopback", async () => {
    const db = fakeTranscriptDb(AGENTS, [storedRun()]);
    const { mcp } = await setup(db, "trig");
    const host = createStdioLinkHost({
      [RUN_TRANSCRIPT_DOWNLOAD_PATH]: (req, res, token) =>
        handleRunTranscriptDownload(req.method, token, res, {
          verify: (t) => mcp.verifyRequestState(t),
          audience: "stdio",
          db,
          blobs: fakeBlobs({ "run-transcripts/r1.jsonl.gz": stored.bytes }),
        }),
    });
    const token = await mcp.mintRequestState<RunTranscriptLinkPayload>({
      kind: "run-transcript",
      aud: "stdio",
      runId: "r1",
      principalId: "trig",
      exp: Date.now() + 60_000,
    });
    const url = await host.urlFor(RUN_TRANSCRIPT_DOWNLOAD_PATH, token);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/run-transcripts\/download\?t=/);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(stored.bytes)).toBe(true);
    expect((await fetch(new URL("/elsewhere", url))).status).toBe(404);
  });
});
