import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "wardby-package-"));
const npmEnv = {
  ...process.env,
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_update_notifier: "false",
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

try {
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", scratch], {
    env: npmEnv,
  });
  const manifestStart = packOutput.lastIndexOf("\n[") + 1;
  if (manifestStart === 0 && !packOutput.startsWith("[")) {
    throw new Error("npm pack did not return a JSON manifest");
  }
  const packed = JSON.parse(packOutput.slice(manifestStart))[0];
  const paths = new Set(packed.files.map((file) => file.path));
  const required = [
    "LICENSE",
    "NOTICE",
    "README.md",
    "dist/wardby-bin.js",
    "dist/cli.js",
    "prisma/schema.prisma",
    "scripts/git-askpass.sh",
  ];
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`packed artifact is missing ${path}`);
  }

  const forbiddenPrefixes = ["docs/", "src/", "node_modules/", ".github/"];
  for (const file of paths) {
    if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
      throw new Error(`packed artifact contains internal path ${file}`);
    }
  }

  const installRoot = scratch;
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
  const tarball = join(scratch, packed.filename);
  run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false", tarball], {
    cwd: scratch,
    env: npmEnv,
  });

  const binary = process.platform === "win32" ? "wardby.cmd" : "wardby";
  const executable = join(scratch, "node_modules", ".bin", binary);
  const help = run(executable, ["--help"], { cwd: installRoot });
  if (!help.includes("wardby coding preflight") || !help.includes("--version")) {
    throw new Error("installed wardby --help output is incomplete");
  }
  const version = run(executable, ["--version"], { cwd: installRoot }).trim();
  if (version !== packageJson.version) {
    throw new Error(`installed version ${version} does not match package ${packageJson.version}`);
  }

  const runtimeProbe = spawnSync(executable, ["agent", "list"], {
    cwd: installRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://wardby:wardby@127.0.0.1:1/wardby?connect_timeout=1",
    },
  });
  const runtimeOutput = `${runtimeProbe.stdout ?? ""}\n${runtimeProbe.stderr ?? ""}`;
  const prismaInitializationErrors = [
    "@prisma/client did not initialize yet",
    "Cannot find module '.prisma/client/default'",
  ];
  if (prismaInitializationErrors.some((message) => runtimeOutput.includes(message))) {
    throw new Error(`installed Prisma runtime is incomplete:\n${runtimeOutput.trim()}`);
  }

  console.log(`package acceptance passed for ${packed.filename} (${packed.size} bytes)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
