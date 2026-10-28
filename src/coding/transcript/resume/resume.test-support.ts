/**
 * Fixtures for the `wardby resume` tests: a local HTTP server that serves a
 * transcript the way the download route does, and temporary git repositories.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  RUN_TRANSCRIPT_DOWNLOAD_PATH,
  TRANSCRIPT_META_HEADER,
  TRANSCRIPT_SESSION_HEADER,
  TRANSCRIPT_SHA256_HEADER,
  type TranscriptDownloadMeta,
} from "../download-protocol.js";

export const RUN_ID = "cmvrtest0000run0000abcd1";
export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
/** A fake link token: the tests check it never appears in output. */
export const FAKE_TOKEN = "v1.FAKETOKENfaketokenFAKETOKEN0123456789abcdef.SIGfakeSIGfake";
export const BODY =
  [
    JSON.stringify({
      type: "user",
      cwd: "/opt/wardby/context",
      sessionId: SESSION_ID,
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: "/opt/wardby/context",
      sessionId: SESSION_ID,
      message: { role: "assistant", content: "ok" },
    }),
  ].join("\n") + "\n";

export function transcriptGzip(body = BODY, sessionId = SESSION_ID): Buffer {
  const header = JSON.stringify({
    type: "wardby-transcript",
    version: 1,
    provider: "claude-code",
    sessionId,
    status: "ok",
  });
  return gzipSync(Buffer.from(`${header}\n${body}`));
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function meta(overrides: Partial<TranscriptDownloadMeta> = {}, gzip = transcriptGzip()): TranscriptDownloadMeta {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    provider: "claude-code",
    repository: "your-org/your-repo",
    headRef: "wardby/run-x",
    resultBranch: null,
    baseSha: null,
    sha256: sha256(gzip),
    ...overrides,
  };
}

export interface ServeOptions {
  gzip?: Buffer;
  meta?: TranscriptDownloadMeta;
  status?: number;
  error?: string;
  /** Overrides the sha256 header (to simulate a mismatch). */
  shaHeader?: string;
}

/** Serves one transcript at RUN_TRANSCRIPT_DOWNLOAD_PATH; records the tokens it was sent. */
export async function serveTranscript(
  opts: ServeOptions = {},
): Promise<{ server: Server; link: string; seen: string[] }> {
  const gzip = opts.gzip ?? transcriptGzip();
  const m = opts.meta ?? meta({}, gzip);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push(url.searchParams.get("t") ?? "");
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status, { "content-type": "application/json" }).end(JSON.stringify({ error: opts.error }));
      return;
    }
    res
      .writeHead(200, {
        "content-type": "application/gzip",
        [TRANSCRIPT_SHA256_HEADER]: opts.shaHeader ?? m.sha256,
        [TRANSCRIPT_SESSION_HEADER]: m.sessionId,
        [TRANSCRIPT_META_HEADER]: Buffer.from(JSON.stringify(m)).toString("base64url"),
      })
      .end(gzip);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    link: `http://127.0.0.1:${port}${RUN_TRANSCRIPT_DOWNLOAD_PATH}?t=${encodeURIComponent(FAKE_TOKEN)}`,
    seen,
  };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A repository with one commit on main and a run branch with a second commit; returns the shas. */
export function makeRepo(parent = mkdtempSync(join(tmpdir(), "wardby-resume-"))): {
  dir: string;
  base: string;
  head: string;
} {
  const dir = join(parent, "app");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "wardby/run-x");
  writeFileSync(join(dir, "README.md"), "run change\n");
  git(dir, "commit", "-q", "-am", "run change");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return { dir, base, head };
}
