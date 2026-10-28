import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { downloadTranscript, parseResumeLink, ResumeError } from "./download.js";
import { FAKE_TOKEN, meta, serveTranscript, transcriptGzip } from "./resume.test-support.js";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function expectRefusal(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ResumeError);
  expect((error as Error).message).toMatch(pattern);
  expect((error as Error).message).not.toContain(FAKE_TOKEN);
  expect((error as Error).message).not.toContain(encodeURIComponent(FAKE_TOKEN));
}

describe("parseResumeLink", () => {
  it("accepts https and loopback http links to the download route", () => {
    expect(parseResumeLink(`https://wardby.example.com/run-transcripts/download?t=${FAKE_TOKEN}`).hostname).toBe(
      "wardby.example.com",
    );
    expect(parseResumeLink(`http://127.0.0.1:4000/run-transcripts/download?t=${FAKE_TOKEN}`).port).toBe("4000");
  });

  it("refuses plain http to another host, other paths and missing tokens, without echoing the link", () => {
    for (const raw of [
      `http://wardby.example.com/run-transcripts/download?t=${FAKE_TOKEN}`,
      `https://wardby.example.com/elsewhere?t=${FAKE_TOKEN}`,
      "https://wardby.example.com/run-transcripts/download",
      `https://user:${FAKE_TOKEN}@wardby.example.com/run-transcripts/download?t=x`,
      `not a link ${FAKE_TOKEN}`,
    ]) {
      let message = "";
      try {
        parseResumeLink(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(FAKE_TOKEN);
    }
  });
});

describe("downloadTranscript", () => {
  it("downloads and verifies the transcript and its metadata", async () => {
    const served = await serveTranscript();
    server = served.server;
    const result = await downloadTranscript(parseResumeLink(served.link));
    expect(result.gzip.equals(transcriptGzip())).toBe(true);
    expect(result.meta).toEqual(meta());
    expect(served.seen).toEqual([FAKE_TOKEN]);
  });

  it("refuses bytes that do not match the server's sha256", async () => {
    const served = await serveTranscript({ shaHeader: "0".repeat(64) });
    server = served.server;
    await expectRefusal(downloadTranscript(parseResumeLink(served.link)), /does not match the server's checksum/);
    const tampered = await serveTranscript({ meta: meta({ sha256: "f".repeat(64) }) });
    tampered.server.unref();
    await expectRefusal(downloadTranscript(parseResumeLink(tampered.link)), /checksum/);
    tampered.server.close();
  });

  it("explains each server refusal without quoting the link", async () => {
    const cases: [number, string, RegExp][] = [
      [403, "link_invalid", /invalid or has expired/],
      [404, "not_found", /no transcript you can read/],
      [410, "transcript_expired", /deleted after the server's retention/],
      [500, "something_else", /HTTP 500/],
    ];
    for (const [status, error, pattern] of cases) {
      const served = await serveTranscript({ status, error });
      await expectRefusal(downloadTranscript(parseResumeLink(served.link)), pattern);
      served.server.close();
    }
  });

  it("refuses metadata with an unsafe run or session id", async () => {
    const served = await serveTranscript({ meta: meta({ runId: "../../etc" }) });
    server = served.server;
    await expectRefusal(downloadTranscript(parseResumeLink(served.link)), /invalid run details/);
  });

  it("says when the server cannot be reached", async () => {
    await expectRefusal(
      downloadTranscript(parseResumeLink(`http://127.0.0.1:1/run-transcripts/download?t=${FAKE_TOKEN}`)),
      /Could not reach http:\/\/127\.0\.0\.1:1/,
    );
  });
});
