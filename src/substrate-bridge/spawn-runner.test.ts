import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnRunner } from "./tool.js";

describe("spawnRunner", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-runner-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(body: string): Promise<string> {
    const path = join(dir, "runner.mjs");
    await writeFile(path, body);
    return path;
  }

  it("resolves ready on the ready line, passes other stdout through, and never echoes the setup", async () => {
    const entry = await script(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PROOF_FILE, process.env.WARDBY_TOOL_SETUP);
console.log("runner says hi");
console.log("wardby_tool_runner_ready");
setTimeout(() => process.exit(7), 100);
`);
    const written: string[] = [];
    const errors: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array) => (written.push(String(chunk)), true);
    process.stderr.write = (chunk: string | Uint8Array) => (errors.push(String(chunk)), true);
    let handle: ReturnType<typeof spawnRunner>;
    let code: number;
    try {
      handle = spawnRunner("SETUP-VALUE-123", { PROOF_FILE: join(dir, "proof") }, entry);
      await handle.ready;
      code = await handle.exited;
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(code).toBe(7);
    expect(await readFile(join(dir, "proof"), "utf8")).toBe("SETUP-VALUE-123");
    // Only the runner's own non-ready line is passed through; the ready line is consumed.
    expect(written.join("")).toContain("runner says hi\n");
    expect(written.join("")).not.toContain("wardby_tool_runner_ready");
    expect([...written, ...errors].join("")).not.toContain("SETUP-VALUE-123");
  });

  it("rejects ready when the runner exits first", async () => {
    const entry = await script("process.exit(3);\n");
    const handle = spawnRunner("x", {}, entry);
    await expect(handle.ready).rejects.toMatchObject({ code: "substrate_bridge_runner_exited" });
    expect(await handle.exited).toBe(3);
  });
});
