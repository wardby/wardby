// Runs the pinned Codex CLI, configured as the worker configures it, against a
// local fake that captures the first Responses request, to check which skills
// Codex offers the model. Nothing leaves the machine. Skipped when the
// platform's Codex binary is not installed.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexSdkClient } from "./sdk.js";
import { disabledCodexSkills } from "./skills.js";

const require = createRequire(import.meta.url);
function codexBinaryInstalled(): boolean {
  try {
    require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

async function offeredSkills(repoSkills: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-codex-skills-e2e-"));
  roots.push(root);
  const workspace = join(root, "ws");
  const home = join(root, "home");
  const skill = async (path: string, name: string) => {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), `---\nname: ${name}\ndescription: probe ${name}\n---\nbody\n`);
  };
  await skill(".agents/skills/alpha/SKILL.md", "alpha");
  await skill(".codex/skills/beta/SKILL.md", "beta");
  await mkdir(home, { recursive: true });
  let resolveBody!: (body: string) => void;
  const body = new Promise<string>((resolve) => (resolveBody = resolve));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      resolveBody(raw);
      res.writeHead(400);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const client = createCodexSdkClient({
      proxyBaseUrl: `http://127.0.0.1:${port}`,
      capability: "not-a-real-key",
      developerInstructions: "Fixed security instructions",
      environment: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_API_KEY: "not-a-real-key" },
      disabledSkills: await disabledCodexSkills(workspace, repoSkills),
    });
    const thread = client.startThread({
      model: "gpt-5.6-terra",
      sandboxMode: "danger-full-access",
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    // The events async iterable must be drained for Codex's child process to keep making
    // progress; discarding the promise without consuming it stalls the process before it
    // ever reaches the model request this test is waiting to capture. The drain promise is
    // also awaited below (after the request this test cares about arrives) so the child
    // process has exited -- and released its files under `home` -- before cleanup removes it.
    const drained = thread
      .runStreamed("hi", { outputSchema: undefined, signal: new AbortController().signal })
      .then(async (streamed) => {
        for await (const _event of streamed.events) {
          // Draining only; this test reads the request the proxy fake captured, not the events.
        }
      })
      .catch(() => undefined);
    const text = await Promise.race([
      body,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("no request")), 30_000)),
    ]);
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    return /<skills_instructions>[\s\S]*?<\/skills_instructions>/.exec(text)?.[0] ?? "";
  } finally {
    server.close();
  }
}

describe.skipIf(!codexBinaryInstalled())("pinned Codex CLI skill loading", () => {
  it("offers the repo's skills and none of the built-ins when repo skills are on", async () => {
    const block = await offeredSkills(true);
    expect(block).toContain("alpha");
    expect(block).toContain("beta");
    for (const builtin of ["imagegen", "openai-docs", "skill-creator", "skill-installer"]) {
      expect(block).not.toContain(`- ${builtin}:`);
    }
  }, 60_000);

  it("offers no skills at all when repo skills are off", async () => {
    expect(await offeredSkills(false)).toBe("");
  }, 60_000);
});
