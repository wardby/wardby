import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnWorker } from "./agent.js";
import { spawnCodexWorker } from "./codex.js";
import { PLACEHOLDER_CAPABILITY, REDACTED } from "./constants.js";
import type { WorkerHandle } from "./worker-run.js";

const REGISTRY_TOKEN = "rrg_fake_registry_token_spawn_0001";

/**
 * A worker that prints both values on stdout and stderr: the registry token split across two writes
 * (with a pause, so they arrive as two chunks), the placeholder, and a last line with no newline.
 */
const WORKER = `
const [a, b] = [process.env.TOKEN.slice(0, 8), process.env.TOKEN.slice(8)];
const both = (text) => { process.stdout.write(text); process.stderr.write(text); };
both("first " + a);
setTimeout(() => {
  both(b + " cap=" + process.env.CAP + "\\n");
  both('{"registryToken":"' + process.env.TOKEN + '"}\\n');
  both("tail " + process.env.TOKEN);
  setTimeout(() => process.exit(0), 20);
}, 50);
`;

describe("a worker's output passed on to the actor's log", () => {
  let dir: string;
  let entry: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-worker-"));
    entry = join(dir, "worker.mjs");
    await writeFile(entry, WORKER);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function capture(): { write(text: string): void; text(): string } {
    let text = "";
    return { write: (piece) => void (text += piece), text: () => text };
  }

  async function finished(handle: WorkerHandle): Promise<void> {
    expect(await handle.exited).toBe(0);
    // Let the streams end (the last partial line is passed on at the end).
    await Promise.all(
      [handle.stdout, handle.stderr].map(
        (stream) =>
          new Promise<void>((resolve) => ((stream as Readable).closed ? resolve() : stream!.once("close", resolve))),
      ),
    );
  }

  const env = { PATH: process.env.PATH, TOKEN: REGISTRY_TOKEN, CAP: PLACEHOLDER_CAPABILITY };
  const expected = [
    `first ${REDACTED} cap=${REDACTED}`,
    `{"registryToken":"${REDACTED}"}`,
    `tail ${REDACTED}`,
    "",
  ].join("\n");

  it("the Codex worker's: redacted by exact value on stdout and stderr, against the live secret list", async () => {
    const stdout = capture();
    const stderr = capture();
    const secrets = [PLACEHOLDER_CAPABILITY];
    const handle = spawnCodexWorker(env, () => secrets, entry, { stdout, stderr });
    // Learned after the spawn: still covered, since the list is read for every line.
    secrets.push(REGISTRY_TOKEN);
    await finished(handle);
    for (const out of [stdout, stderr]) {
      expect(out.text()).toBe(expected);
      expect(out.text()).not.toContain(REGISTRY_TOKEN);
      expect(out.text()).not.toContain(REGISTRY_TOKEN.slice(8));
      expect(out.text()).not.toContain(PLACEHOLDER_CAPABILITY);
    }
  });

  it("the Claude worker's: redacted against the placeholder by default", async () => {
    const stdout = capture();
    const stderr = capture();
    const handle = spawnWorker({ ...env, TOKEN: "not-a-secret-value" }, undefined, entry, { stdout, stderr });
    await finished(handle);
    for (const out of [stdout, stderr]) {
      expect(out.text()).toContain(`cap=${REDACTED}`);
      expect(out.text()).not.toContain(PLACEHOLDER_CAPABILITY);
      expect(out.text()).toContain("tail not-a-secret-value\n");
    }
  });
});
