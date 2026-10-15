import { spawn } from "node:child_process";
import { watch } from "node:fs";
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
    WARDBY_NPM_PLAN_REGISTRY: registry,
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

  it("sends nothing to a registry other than the proxy's own, and still runs npm", async () => {
    const { shim, project, env, calls } = await layout();
    await writeFile(join(project, "package-lock.json"), "{}");
    for (const expected of [undefined, `http://wardby-proxy:8787/registry/npm/`]) {
      const result = await run(shim, ["ci"], { cwd: project, env: { ...env, WARDBY_NPM_PLAN_REGISTRY: expected } });
      expect(result.code).toBe(0);
    }
    expect(plans).toEqual([]);
    expect(await calls()).toHaveLength(2);
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

/** The shim linked as `tool` (pnpm or yarn), with fake real binaries for
 *  the names in `real` (each records its name, arguments, the yarn.lock it
 *  saw, and may rewrite yarn.lock from FAKE_WRITE_LOCK). */
async function toolLayout(tool: "pnpm" | "yarn", real: string[]) {
  const base = await layout();
  const shimDir = join(root, "shim");
  await symlink("npm-shim.mjs", join(shimDir, tool));
  const realDir = join(root, "real-tools");
  await mkdir(realDir);
  const record = join(root, "tool-calls.jsonl");
  for (const name of real) {
    await writeFile(
      join(realDir, name),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'let lock; try { lock = fs.readFileSync("yarn.lock", "utf8"); } catch {}',
        `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2), active: process.env.WARDBY_NPM_SHIM_ACTIVE, alwaysAuth: process.env.npm_config_always_auth, storeDir: process.env.npm_config_store_dir, cacheDir: process.env.npm_config_cache_dir, cacheFolder: process.env.npm_config_cache_folder, lock }) + "\\n");`,
        'if (process.env.FAKE_WRITE_LOCK) fs.writeFileSync("yarn.lock", process.env.FAKE_WRITE_LOCK);',
        "if (process.env.FAKE_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_SLEEP_MS));",
        "process.exit(Number(process.env.FAKE_EXIT ?? 0));",
      ].join("\n"),
    );
    await chmod(join(realDir, name), 0o755);
  }
  const calls = async () =>
    (await readFile(record, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string;
            args: string[];
            active?: string;
            alwaysAuth?: string;
            storeDir?: string;
            cacheDir?: string;
            cacheFolder?: string;
            lock?: string;
          },
      );
  // Only node and the fake tools: no real pnpm, yarn or corepack from the host.
  const nodeDir = join(root, "node-only");
  await mkdir(nodeDir);
  await symlink(process.execPath, join(nodeDir, "node"));
  const env = { ...base.env, PATH: [shimDir, realDir, nodeDir, "/usr/bin", "/bin"].join(":") };
  return { shim: join(shimDir, tool), project: base.project, env, calls };
}

describe("package-manager shim for pnpm", () => {
  it("plans the workspace's pnpm-lock.yaml before install, add and i, from a package below it", async () => {
    const { shim, project, env, calls } = await toolLayout("pnpm", ["pnpm"]);
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(join(project, "packages", "web"), { recursive: true });
    await writeFile(join(project, "packages", "web", "package.json"), "{}");
    for (const args of [["install", "--frozen-lockfile"], ["add", "zod"], ["i"]]) {
      const result = await run(shim, args, { cwd: join(project, "packages", "web"), env });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("wardby: verified ../../pnpm-lock.yaml: 2 approved, 0 refused");
    }
    expect(plans.map((plan) => [plan.url, plan.authorization, plan.body])).toEqual(
      Array(3).fill(["POST /registry/npm/-/plan", "Bearer rrg_shim_token", "lockfileVersion: '9.0'\n"]),
    );
    expect((await calls()).map((call) => [call.name, call.args, call.active])).toEqual([
      ["pnpm", ["install", "--frozen-lockfile"], "1"],
      ["pnpm", ["add", "zod"], "1"],
      ["pnpm", ["i"], "1"],
    ]);
  });

  it("just runs pnpm for other commands and without a lockfile", async () => {
    const { shim, project, env, calls } = await toolLayout("pnpm", ["pnpm"]);
    expect((await run(shim, ["install"], { cwd: project, env })).code).toBe(0);
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect((await run(shim, ["run", "build"], { cwd: project, env })).code).toBe(0);
    expect(plans).toEqual([]);
    expect(await calls()).toHaveLength(2);
  });

  it("runs pnpm through corepack when no pnpm is installed", async () => {
    const missing = await toolLayout("pnpm", ["corepack"]);
    await writeFile(join(missing.project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect((await run(missing.shim, ["install"], { cwd: missing.project, env: missing.env })).code).toBe(0);
    expect((await missing.calls()).map((call) => [call.name, call.args])).toEqual([["corepack", ["pnpm", "install"]]]);
    expect(plans).toHaveLength(1);
  });

  it("runs pnpm through corepack when the project pins a release", async () => {
    const pinned = await toolLayout("pnpm", ["pnpm", "corepack"]);
    await writeFile(join(pinned.project, "package.json"), JSON.stringify({ packageManager: "pnpm@10.4.1" }));
    expect((await run(pinned.shim, ["install"], { cwd: pinned.project, env: pinned.env })).code).toBe(0);
    expect((await pinned.calls()).map((call) => [call.name, call.args])).toEqual([["corepack", ["pnpm", "install"]]]);
  });

  it("gives pnpm alone its store and cache under the worker's npm cache folder", async () => {
    const { shim, project, env, calls } = await toolLayout("pnpm", ["pnpm"]);
    const cache = join(root, "npm-cache");
    expect((await run(shim, ["run", "build"], { cwd: project, env: { ...env, npm_config_cache: cache } })).code).toBe(
      0,
    );
    expect((await calls())[0]).toMatchObject({
      storeDir: join(cache, "pnpm-store"),
      cacheDir: join(cache, "pnpm-cache"),
    });
    expect((await calls())[0].cacheFolder).toBeUndefined();
  });

  it("reports a missing pnpm with no corepack", async () => {
    const { shim, project, env } = await toolLayout("pnpm", []);
    const result = await run(shim, ["install"], { cwd: project, env });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("wardby: pnpm is not installed");
  });
});

describe("package-manager shim for yarn", () => {
  const classic = (host: string) =>
    [
      "# yarn lockfile v1",
      "",
      '"@s/a@^1.0.0":',
      '  version "1.0.0"',
      `  resolved "${host}@s/a/-/a-1.0.0.tgz#0123456789abcdef0123456789abcdef01234567"`,
      "  integrity sha512-a",
      "",
    ].join("\n");

  it("plans yarn.lock for a bare yarn, install and add; not for other commands", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn"]);
    await writeFile(join(project, "yarn.lock"), "__metadata:\n  version: 8\n");
    for (const args of [[], ["install", "--immutable"], ["--immutable"], ["add", "zod"], ["test"]]) {
      expect((await run(shim, args, { cwd: project, env })).code).toBe(0);
    }
    expect(plans).toHaveLength(4);
    expect(plans[0].body).toBe("__metadata:\n  version: 8\n");
    expect((await calls()).map((call) => call.args)).toEqual([
      [],
      ["install", "--immutable"],
      ["--immutable"],
      ["add", "zod"],
      ["test"],
    ]);
  });

  it("points a classic lockfile's registry URLs at the proxy for the install, then restores it unchanged", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn"]);
    const original = classic("https://registry.yarnpkg.com/");
    await writeFile(join(project, "yarn.lock"), original);
    const result = await run(shim, ["install", "--frozen-lockfile"], { cwd: project, env });
    expect(result.code).toBe(0);
    // yarn classic downloads from the URLs the lockfile records, never from
    // its configured registry: it saw the proxy's.
    expect((await calls())[0].lock).toBe(classic(env.npm_config_registry));
    expect(plans[0].body).toBe(original);
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(original);
  });

  it("maps a lockfile yarn rewrote back to the host the original used", async () => {
    const { shim, project, env } = await toolLayout("yarn", ["yarn"]);
    await writeFile(join(project, "yarn.lock"), classic("https://registry.npmjs.org/"));
    const written = [
      classic(env.npm_config_registry),
      'b@^2.0.0:\n  version "2.0.0"',
      `  resolved "${env.npm_config_registry}-/tarball/b/2.0.0#ab"`,
      "",
    ].join("\n");
    const result = await run(shim, ["add", "b"], { cwd: project, env: { ...env, FAKE_WRITE_LOCK: written } });
    expect(result.code).toBe(0);
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(
      [
        classic("https://registry.npmjs.org/"),
        'b@^2.0.0:\n  version "2.0.0"',
        '  resolved "https://registry.npmjs.org/b/-/b-2.0.0.tgz#ab"',
        "",
      ].join("\n"),
    );
  });

  it("runs yarn through corepack when the project pins yarn 2 or later, and the installed yarn otherwise", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn", "corepack"]);
    await writeFile(join(project, "package.json"), JSON.stringify({ packageManager: "yarn@4.18.1" }));
    expect((await run(shim, ["install"], { cwd: project, env })).code).toBe(0);
    await writeFile(join(project, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.19+sha512.abc" }));
    expect((await run(shim, ["install"], { cwd: project, env })).code).toBe(0);
    expect((await calls()).map((call) => [call.name, call.args])).toEqual([
      ["corepack", ["yarn", "install"]],
      ["yarn", ["install"]],
    ]);
  });

  it("gives yarn alone its cache folder under the worker's npm cache folder", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn"]);
    const cache = join(root, "npm-cache");
    expect((await run(shim, ["test"], { cwd: project, env: { ...env, npm_config_cache: cache } })).code).toBe(0);
    expect((await calls())[0]).toMatchObject({ cacheFolder: join(cache, "yarn-classic") });
    expect((await calls())[0].storeDir).toBeUndefined();
  });

  it("has yarn classic send the token with every registry request, not only for scoped packages", async () => {
    // yarn classic reads the token from the npmrc but sends it only with
    // always-auth, a setting npm itself warns about: so only yarn gets it.
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn"]);
    expect((await run(shim, ["install"], { cwd: project, env })).code).toBe(0);
    expect((await calls())[0].alwaysAuth).toBe("true");
  });

  it("restores the lockfile when the install is killed", async () => {
    const { shim, project, env } = await toolLayout("yarn", ["yarn"]);
    const original = classic("https://registry.yarnpkg.com/");
    await writeFile(join(project, "yarn.lock"), original);
    const child = spawn(shim, ["install"], { cwd: project, env: { ...env, FAKE_SLEEP_MS: "5000" } });
    // Once the plan is made the lockfile points at the proxy; then kill.
    for (let waited = 0; waited < 5000; waited += 50) {
      if ((await readFile(join(project, "yarn.lock"), "utf8")) !== original) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await readFile(join(project, "yarn.lock"), "utf8")).not.toBe(original);
    child.kill("SIGTERM");
    const signal = await new Promise((resolve) => child.once("close", (_code, signal) => resolve(signal)));
    expect(signal).toBe("SIGTERM");
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(original);
  }, 15_000);

  it("restores the lockfile when killed the moment it is rewritten", async () => {
    const { shim, project, env } = await toolLayout("yarn", ["yarn"]);
    const original = classic("https://registry.yarnpkg.com/");
    // A signal right after the rewrite, before the real tool starts, must
    // still put the public URLs back. Repeat: the gap is short.
    for (let attempt = 0; attempt < 15; attempt++) {
      await writeFile(join(project, "yarn.lock"), original);
      const child = spawn(shim, ["install"], { cwd: project, env: { ...env, FAKE_SLEEP_MS: "5000" } });
      const closed = new Promise((resolve) => child.once("close", (_code, signal) => resolve(signal)));
      const watcher = watch(project, () => {
        watcher.close();
        child.kill("SIGTERM");
      });
      expect(await closed).toBe("SIGTERM");
      watcher.close();
      expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(original);
    }
  }, 60_000);

  it("reads packageManager from the workspace root when run from a workspace package", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn", "corepack"]);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"], packageManager: "yarn@4.18.1" }),
    );
    await mkdir(join(project, "packages", "web"), { recursive: true });
    await writeFile(join(project, "packages", "web", "package.json"), JSON.stringify({ name: "web" }));
    expect((await run(shim, ["add", "zod"], { cwd: join(project, "packages", "web"), env })).code).toBe(0);
    expect((await calls()).map((call) => [call.name, call.args])).toEqual([["corepack", ["yarn", "add", "zod"]]]);
  });

  it("points the lockfile at the proxy for every command that installs from it", async () => {
    const { shim, project, env, calls } = await toolLayout("yarn", ["yarn"]);
    const original = classic("https://registry.yarnpkg.com/");
    await writeFile(join(project, "yarn.lock"), original);
    const commands = [
      ["remove", "left-pad"],
      ["upgrade"],
      ["upgrade-interactive"],
      ["workspace", "web", "add", "zod"],
      ["workspace", "web", "remove", "zod"],
      ["workspace", "web", "upgrade"],
    ];
    for (const args of commands) expect((await run(shim, args, { cwd: project, env })).code).toBe(0);
    expect((await calls()).map((call) => call.lock)).toEqual(commands.map(() => classic(env.npm_config_registry)));
    expect(plans).toHaveLength(commands.length);
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(original);
    // A workspace's own scripts don't install anything.
    expect((await run(shim, ["workspace", "web", "test"], { cwd: project, env })).code).toBe(0);
    expect(plans).toHaveLength(commands.length);
  });

  it("puts each entry back on its own host after yarn rewrote a mixed-host lockfile", async () => {
    const { shim, project, env } = await toolLayout("yarn", ["yarn"]);
    const entry = (name: string, host: string) =>
      [`${name}@^1.0.0:`, '  version "1.0.0"', `  resolved "${host}${name}/-/${name}-1.0.0.tgz#aa"`, ""].join("\n");
    const npmjs = "https://registry.npmjs.org/";
    const yarnpkg = "https://registry.yarnpkg.com/";
    const proxy = env.npm_config_registry;
    const header = "# yarn lockfile v1\n\n";
    await writeFile(
      join(project, "yarn.lock"),
      header + [entry("a", npmjs), entry("b", yarnpkg), entry("c", yarnpkg)].join("\n"),
    );
    // yarn add d: yarn rewrites every entry (through the proxy) and adds d,
    // at the proxy's own download route.
    const written =
      header +
      [
        entry("a", proxy),
        entry("b", proxy),
        entry("c", proxy),
        ["d@^1.0.0:", '  version "1.0.0"', `  resolved "${proxy}-/tarball/d/1.0.0#bb"`, ""].join("\n"),
      ].join("\n");
    expect((await run(shim, ["add", "d"], { cwd: project, env: { ...env, FAKE_WRITE_LOCK: written } })).code).toBe(0);
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(
      header +
        [
          entry("a", npmjs),
          entry("b", yarnpkg),
          entry("c", yarnpkg),
          ["d@^1.0.0:", '  version "1.0.0"', `  resolved "${yarnpkg}d/-/d-1.0.0.tgz#bb"`, ""].join("\n"),
        ].join("\n"),
    );
  });

  it("passes yarn's exit code through and still restores the lockfile", async () => {
    const { shim, project, env } = await toolLayout("yarn", ["yarn"]);
    const original = classic("https://registry.yarnpkg.com/");
    await writeFile(join(project, "yarn.lock"), original);
    const result = await run(shim, ["install"], { cwd: project, env: { ...env, FAKE_EXIT: "4" } });
    expect(result.code).toBe(4);
    expect(await readFile(join(project, "yarn.lock"), "utf8")).toBe(original);
  });
});
