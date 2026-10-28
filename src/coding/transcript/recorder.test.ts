import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobStoreError, type BlobStore } from "../../providers/storage/types.js";
import { LocalBlobStore } from "../../providers/storage/local.js";
import { deriveRegistryToken } from "../registry/token.js";
import { sanitizeClaudeTranscript } from "./claude-code.js";
import { formatTranscriptFile, type TranscriptHeader } from "./format.js";
import {
  loadTranscriptRetentionDays,
  RunTranscriptRecorder,
  transcriptBlobKey,
  type RunTranscriptRecorderDeps,
} from "./recorder.js";

const FIXTURE = readFileSync(new URL("./fixtures/claude-session.jsonl", import.meta.url), "utf8");
const SECRET = "fake-secret-value-0001";
const CAPABILITY = "rrp_abcdefghijklmnop";
const RAW2 = 'fake"sec\\ret-0002';
const NOW = new Date("2026-03-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const okHeader = (sessionId: string): TranscriptHeader => ({
  type: "wardby-transcript",
  version: 1,
  provider: "claude-code",
  sessionId,
  status: "ok",
});

/** Worker-shaped output for the fixture, with secrets planted in kept content. */
function workerFile(extraBodyLines: string[] = [], assistantText = `token ${CAPABILITY} here`): string {
  const sanitized = sanitizeClaudeTranscript(FIXTURE)!;
  const lines = sanitized.lines.map((line) => {
    const rec = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result") block.content = `output ${SECRET} and ${RAW2} end`;
        if (block.type === "text" && rec.type === "assistant") block.text = assistantText;
      }
    }
    return JSON.stringify(rec);
  });
  return formatTranscriptFile(okHeader(sanitized.sessionId), [...lines, ...extraBodyLines]);
}

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const upsert = vi.fn(async (args: { where: { runId: string }; create: Record<string, unknown> }) => {
    rows.set(args.where.runId, args.create);
    return args.create;
  });
  const findMany = vi.fn(async (args: { where: { expiresAt: { lt: Date } }; take: number }) =>
    [...rows.values()]
      .filter((r) => (r.expiresAt as Date) < args.where.expiresAt.lt)
      .slice(0, args.take)
      .map((r) => ({ runId: r.runId, blobKey: r.blobKey ?? null })),
  );
  const deleteMany = vi.fn(async (args: { where: { runId: { in: string[] } } }) => {
    let count = 0;
    for (const id of args.where.runId.in) if (rows.delete(id)) count++;
    return { count };
  });
  return { rows, upsert, findMany, deleteMany, db: { runTranscript: { upsert, findMany, deleteMany } } };
}

describe("RunTranscriptRecorder", () => {
  let dir: string;
  let blobs: LocalBlobStore;
  let fake: ReturnType<typeof fakeDb>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "transcript-rec-"));
    blobs = new LocalBlobStore(dir);
    fake = fakeDb();
  });
  afterEach(async () => {
    noLeak();
    await rm(dir, { recursive: true, force: true });
  });

  function recorder(over: Partial<RunTranscriptRecorderDeps> = {}) {
    return new RunTranscriptRecorder({
      db: fake.db as unknown as RunTranscriptRecorderDeps["db"],
      blobs,
      secretValues: async () => [SECRET, RAW2],
      retentionDays: 30,
      now: () => NOW,
      ...over,
    });
  }
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run1",
    agentId: "agent1",
    provider: "claude-code",
    read: async () => workerFile() as string | undefined,
    ...over,
  });
  const row = () => fake.rows.get("run1")!;
  const noLeak = () => {
    expect(JSON.stringify(fake.upsert.mock.calls)).not.toContain(RAW2);
    const json = JSON.stringify(fake.upsert.mock.calls);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(CAPABILITY);
    expect(json).not.toContain("README.md");
  };

  it("stores a redacted, re-sanitised transcript", async () => {
    const status = await recorder().record(input());
    expect(status).toBe("stored");
    const blob = await blobs.get(transcriptBlobKey("run1"));
    const text = blob.toString("utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(CAPABILITY);
    expect(text).not.toContain(RAW2);
    expect(text).not.toContain(JSON.stringify(RAW2).slice(1, -1));
    for (const line of text.trim().split("\n")) JSON.parse(line);
    expect(row()).toMatchObject({
      status: "stored",
      reason: null,
      sizeBytes: blob.byteLength,
      sha256: createHash("sha256").update(blob).digest("hex"),
      sessionId: "00000000-0000-4000-8000-000000000001",
      blobKey: "run-transcripts/run1.jsonl",
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    noLeak();
  });

  it("removes a realistic capability and registry token without being given either", async () => {
    const capability = `rrp_${randomBytes(32).toString("base64url")}`;
    const token = deriveRegistryToken(capability);
    const text0 = workerFile([], `keys ${capability} and ${token}`);
    expect(text0).toContain(capability);
    await recorder({ secretValues: async () => [] }).record(input({ read: async () => text0 }));
    const text = (await blobs.get(transcriptBlobKey("run1"))).toString("utf8");
    expect(text).not.toContain(capability);
    expect(text).not.toContain(token);
  });

  it("reports not_captured/no_blob_store without reading", async () => {
    const read = vi.fn();
    expect(await recorder({ blobs: undefined }).record(input({ read }))).toBe("not_captured");
    expect(read).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "not_captured", reason: "no_blob_store" });
  });

  it("reports missing when nothing was read", async () => {
    expect(await recorder().record(input({ read: async () => undefined }))).toBe("not_captured");
    expect(row()).toMatchObject({ reason: "missing" });
  });

  it("maps read failures", async () => {
    const tooLarge = async () => {
      throw new Error("transcript_too_large");
    };
    expect(await recorder().record(input({ read: tooLarge }))).toBe("too_large");
    expect(row()).toMatchObject({ status: "too_large" });
    const other = async () => {
      throw new Error("boom");
    };
    expect(await recorder().record(input({ read: other }))).toBe("not_captured");
    expect(row()).toMatchObject({ reason: "unreadable" });
  });

  it("maps header statuses and invalid files", async () => {
    const hdr = (status: TranscriptHeader["status"]) =>
      formatTranscriptFile({ ...okHeader("00000000-0000-4000-8000-000000000002"), status }, []);
    expect(await recorder().record(input({ read: async () => hdr("too_large") }))).toBe("too_large");
    expect(row()).toMatchObject({ sessionId: "00000000-0000-4000-8000-000000000002" });
    expect(await recorder().record(input({ read: async () => hdr("no_complete_turn") }))).toBe("not_captured");
    expect(row()).toMatchObject({ reason: "no_complete_turn" });
    expect(await recorder().record(input({ read: async () => "not json\n" }))).toBe("failed");
    expect(row()).toMatchObject({ reason: "invalid_file" });
  });

  it("fails closed without secrets", async () => {
    const rejecting = recorder({
      secretValues: async () => {
        throw new Error(`vault says ${SECRET}`);
      },
    });
    const unread = vi.fn(async () => workerFile() as string | undefined);
    expect(await rejecting.record(input({ read: unread }))).toBe("failed");
    expect(row()).toMatchObject({ reason: "secrets_unavailable", blobKey: null });
    await expect(blobs.get(transcriptBlobKey("run1"))).rejects.toBeInstanceOf(BlobStoreError);
    noLeak();
  });

  it("re-sanitises the worker body", async () => {
    const planted = JSON.stringify({
      type: "attachment",
      uuid: "zz",
      parentUuid: null,
      sessionId: "00000000-0000-4000-8000-000000000001",
      attachment: { type: "prompt_snapshot", systemPrompt: ["SYSTEM PROMPT TEXT"] },
    });
    expect(await recorder().record(input({ read: async () => workerFile([planted]) }))).toBe("stored");
    const text = (await blobs.get(transcriptBlobKey("run1"))).toString("utf8");
    expect(text).not.toContain("SYSTEM PROMPT TEXT");
  });

  it("rejects a worker-controlled sessionId that is not a UUID", async () => {
    const badHeader = formatTranscriptFile({ ...okHeader(SECRET) }, []);
    for (const status of ["ok", "too_large", "no_complete_turn"] as const) {
      const file = formatTranscriptFile({ ...okHeader(SECRET), status }, []);
      expect(await recorder().record(input({ read: async () => file }))).toBe("failed");
      expect(row()).toMatchObject({ reason: "invalid_file", sessionId: null });
      noLeak();
    }
    expect(badHeader).toContain(SECRET);
    const good = workerFile();
    const planted = good.replaceAll("00000000-0000-4000-8000-000000000001", SECRET);
    const body = planted.slice(planted.indexOf("\n") + 1);
    const file = formatTranscriptFile(okHeader("00000000-0000-4000-8000-000000000001"), body.trim().split("\n"));
    fake.rows.clear();
    expect(await recorder().record(input({ read: async () => file }))).toBe("failed");
    expect(row()).toMatchObject({ reason: "invalid_file", sessionId: null, blobKey: null });
    noLeak();
    await expect(blobs.get(transcriptBlobKey("run1"))).rejects.toBeInstanceOf(BlobStoreError);
  });

  it("does not support codex", async () => {
    expect(await recorder().record(input({ provider: "codex" }))).toBe("not_captured");
    expect(row()).toMatchObject({ reason: "provider_unsupported", provider: "codex" });
  });

  it("records store_failed and still writes the row", async () => {
    const failing = {
      put: async () => {
        throw new Error(`disk ${SECRET}`);
      },
    } as unknown as BlobStore;
    expect(await recorder({ blobs: failing }).record(input())).toBe("failed");
    expect(row()).toMatchObject({ reason: "store_failed" });
    noLeak();
  });

  it("never throws when the database fails, and reports a fixed code for the lost row", async () => {
    fake.upsert.mockRejectedValue(new Error(`db down ${SECRET}`));
    await expect(recorder().record(input())).resolves.toBe("row_write_failed");
  });

  it("stores a curl call with a Bearer header and removes the token after Bearer", async () => {
    const token = "ghp_fakeTokenValue0000000000000000000001";
    const command = `curl -H "Authorization: Bearer ${token}" https://x`;
    const toolUse = workerFile([], "done").replace(
      /"type":"tool_use"(.*?)"input":\{[^}]*\}/,
      (_match, between: string) => `"type":"tool_use"${between}"input":${JSON.stringify({ command })}`,
    );
    expect(toolUse).toContain(JSON.stringify(command).slice(1, -1));
    expect(await recorder({ secretValues: async () => [] }).record(input({ read: async () => toolUse }))).toBe(
      "stored",
    );
    const text = (await blobs.get(transcriptBlobKey("run1"))).toString("utf8");
    expect(text).not.toContain(token);
    expect(text).toContain("Authorization: [REDACTED]");
    expect(text).toContain("https://x");
    for (const line of text.trim().split("\n")) JSON.parse(line);
  });

  it("redacts a secret planted in a nested object key and value", async () => {
    const sanitized = sanitizeClaudeTranscript(FIXTURE)!;
    const lines = sanitized.lines.map((line) => {
      const rec = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use") block.input = { outer: { [`key-${SECRET}`]: [{ deep: `v ${RAW2}` }] } };
        }
      }
      return JSON.stringify(rec);
    });
    const file = formatTranscriptFile(okHeader(sanitized.sessionId), lines);
    expect(file).toContain(`key-${SECRET}`);
    expect(await recorder().record(input({ read: async () => file }))).toBe("stored");
    const text = (await blobs.get(transcriptBlobKey("run1"))).toString("utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(JSON.stringify(RAW2).slice(1, -1));
    expect(text).toContain("key-[REDACTED]");
    expect(text).toContain("v [REDACTED]");
  });

  it("redacts a digits-only secret written as a JSON number, including one too long for a double", async () => {
    const pin = "48213907";
    const longPin = "98765432109876543210";
    const sanitized = sanitizeClaudeTranscript(FIXTURE)!;
    const lines = sanitized.lines.map((line) => {
      const rec = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use") block.input = { account: 0, other: 0, count: 3 };
        }
      }
      return JSON.stringify(rec).replace('"account":0', `"account":${pin}`).replace('"other":0', `"other":${longPin}`);
    });
    const file = formatTranscriptFile(okHeader(sanitized.sessionId), lines);
    expect(file).toContain(`"account":${pin}`);
    expect(file).toContain(`"other":${longPin}`);
    const rec = recorder({ secretValues: async () => [SECRET, RAW2, pin, longPin] });
    expect(await rec.record(input({ read: async () => file }))).toBe("stored");
    const text = (await blobs.get(transcriptBlobKey("run1"))).toString("utf8");
    expect(text).not.toContain(pin);
    expect(text).not.toContain(longPin.slice(0, 15));
    expect(text).toContain('"account":"[REDACTED]"');
    expect(text).toContain('"other":"[REDACTED]"');
    expect(text).toContain('"count":3');
  });

  it("keeps a row whose blob cannot be deleted but prunes the rest", async () => {
    const rec = recorder();
    for (const id of ["a", "b", "c"]) await rec.record(input({ runId: id }));
    const flaky = {
      delete: async (key: string) => {
        if (key === transcriptBlobKey("b")) throw new Error("denied");
        await blobs.delete(key);
      },
    } as unknown as BlobStore;
    const later = recorder({ blobs: flaky, now: () => new Date(NOW.getTime() + 31 * DAY) });
    expect(await later.pruneExpired()).toBe(2);
    expect([...fake.rows.keys()]).toEqual(["b"]);
  });

  it("prunes expired rows and blobs, tolerating not_found, up to the limit", async () => {
    const rec = recorder();
    for (const id of ["a", "b", "c"]) {
      await rec.record(input({ runId: id }));
    }
    await blobs.delete(transcriptBlobKey("a"));
    const later = recorder({ now: () => new Date(NOW.getTime() + 31 * DAY) });
    expect(await later.pruneExpired(2)).toBe(2);
    expect(fake.rows.size).toBe(1);
    expect(await later.pruneExpired()).toBe(1);
    expect(fake.rows.size).toBe(0);
    await expect(blobs.get(transcriptBlobKey("b"))).rejects.toBeInstanceOf(BlobStoreError);
    expect(await later.pruneExpired()).toBe(0);
  });
});

describe("loadTranscriptRetentionDays", () => {
  it("defaults to 30 and validates", () => {
    expect(loadTranscriptRetentionDays({})).toBe(30);
    expect(loadTranscriptRetentionDays({ RUN_TRANSCRIPT_RETENTION_DAYS: "7" })).toBe(7);
    for (const bad of ["0", "3651", "1.5", "abc"]) {
      expect(() => loadTranscriptRetentionDays({ RUN_TRANSCRIPT_RETENTION_DAYS: bad })).toThrow();
    }
  });
});
