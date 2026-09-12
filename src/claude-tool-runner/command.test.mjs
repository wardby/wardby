import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_BYTES, runCommand, toolEnvironment } from "./command.mjs";

test("runs commands in the supplied workspace with a scrubbed environment and bounded output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "reevo-claude-tools-"));
  try {
    const env = toolEnvironment();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);

    const result = await runCommand('test -z "$ANTHROPIC_API_KEY" && printf absent', 1_000, workspace);
    assert.deepEqual(result, { code: 0, output: "absent" });

    const bounded = await runCommand("head -c 70000 /dev/zero", 1_000, workspace);
    assert.equal(bounded.code, 0);
    assert.equal(Buffer.byteLength(bounded.output), MAX_OUTPUT_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
