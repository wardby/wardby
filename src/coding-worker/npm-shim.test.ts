import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHIM = fileURLToPath(new URL("./npm-shim.mjs", import.meta.url));

interface PlanCall {
  url: string;
  authorization: string | undefined;
  body: string;
}

let root: string;
let server: Server;
let port: number;
let plans: PlanCall[];
let answer: { status: number; body: string };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wardby-npm-shim-"));
  plans = [];
  answer = { status: 200, body: JSON.stringify({ approved: 2, refused: [] }) };
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      plans.push({ url: `${request.method} ${request.url}`, authorization: request.headers.authorization, body });
      response.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** A fake real npm that records its arguments and exits with `code`, a
 *  shim directory holding the shim as `npm` (as the driver image does),
 *  and the npmrc the driver writes. */
async function layout(code = 0) {
  const shimDir = join(root, "shim");
  const realDir = join(root, "real");
  await mkdir(shimDir);
  await mkdir(realDir);
  // As the driver image installs it: an executable npm-shim.mjs, linked as npm.
  await copyFile(SHIM, join(shimDir, "npm-shim.mjs"));
  await chmod(join(shimDir, "npm-shim.mjs"), 0o755);
  await symlink("npm-shim.mjs", join(shimDir, "npm"));
  const record = join(root, "npm-calls.jsonl");
  await writeFile(
    join(realDir, "npm"),
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), active: process.env.WARDBY_NPM_SHIM_ACTIVE }) + "\\n");\nprocess.exit(${code});\n`,
  );
  await chmod(join(realDir, "npm"), 0o755);
  const registry = `http://127.0.0.1:${port}/registry/npm/`;
  const npmrc = join(root, "npmrc");
  await writeFile(npmrc, `//127.0.0.1:${port}/registry/npm/:_authToken=rrg_shim_token\n`);
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{}");
  const env = {
    PATH: [shimDir, realDir, ...(process.env.PATH ?? "").split(":")].join(":"),
    HOME: root,
    npm_config_registry: registry,
    npm_config_userconfig: npmrc,
  };
  const calls = async () =>
    (await readFile(record, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; active?: string });
  return { shim: join(shimDir, "npm"), project, env, calls };
}

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

describe("npm shim", () => {
  it("plans the lockfile, then runs the real npm with the original arguments", async () => {
    const { shim, project, env, calls } = await layout();
    await writeFile(join(project, "package-lock.json"), '{"lockfileVersion":3}');
    const result = await run(shim, ["ci", "--no-audit"], { cwd: project, env });
    expect(result.code).toBe(0);
    expect(plans).toEqual([
      { url: "POST /registry/npm/-/plan", authorization: "Bearer rrg_shim_token", body: '{"lockfileVersion":3}' },
    ]);
    expect(result.stderr).toContain("wardby: verified package-lock.json: 2 approved, 0 refused");
    expect(await calls()).toEqual([{ args: ["ci", "--no-audit"], active: "1" }]);
  });

  it("plans for install and its aliases, from a subdirectory of the project, and lists refusals", async () => {
    const { shim, project, env, calls } = await layout();
    await writeFile(join(project, "package-lock.json"), "{}");
    await mkdir(join(project, "src"));
    answer = {
      status: 200,
      body: JSON.stringify({
        approved: 1,
        refused: [{ name: "evil", version: "1.0.0", code: "wardby_package_not_allowed", reason: "unreachable" }],
      }),
    };
    for (const command of ["install", "i", "add"]) {
      const result = await run(shim, [command, "left-pad"], { cwd: join(project, "src"), env });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("wardby:   refused evil@1.0.0: wardby_package_not_allowed (unreachable)");
    }
    expect(plans).toHaveLength(3);
    expect((await calls()).map((call) => call.args[0])).toEqual(["install", "i", "add"]);
  });

  it("just runs npm for other commands, without a lockfile, and when nested", async () => {
    const { shim, project, env, calls } = await layout();
    expect((await run(shim, ["ci"], { cwd: project, env })).code).toBe(0);
    await writeFile(join(project, "package-lock.json"), "{}");
    expect((await run(shim, ["test"], { cwd: project, env })).code).toBe(0);
    expect((await run(shim, ["--version"], { cwd: project, env })).code).toBe(0);
    expect((await run(shim, ["ci"], { cwd: project, env: { ...env, WARDBY_NPM_SHIM_ACTIVE: "1" } })).code).toBe(0);
    expect(plans).toEqual([]);
    expect((await calls()).map((call) => call.args)).toEqual([["ci"], ["test"], ["--version"], ["ci"]]);
  });

  it("still runs npm when the plan fails, and passes npm's exit code through", async () => {
    const { shim, project, env, calls } = await layout(3);
    await writeFile(join(project, "package-lock.json"), "{}");
    answer = { status: 503, body: JSON.stringify({ error: "wardby_audit_unavailable: OSV down" }) };
    const refused = await run(shim, ["ci"], { cwd: project, env });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain(
      "package-lock.json was not verified (wardby_audit_unavailable: OSV down); installing with the registry's usual checks",
    );
    const unreachable = await run(shim, ["ci"], {
      cwd: project,
      env: { ...env, npm_config_registry: "http://127.0.0.1:1/registry/npm/" },
    });
    expect(unreachable.code).toBe(3);
    expect(await calls()).toHaveLength(2);
  });
});
