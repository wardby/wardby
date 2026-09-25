// Runs INSIDE a clean linux/amd64 node container (see
// npm-package-acceptance.mjs): installs the packed tarball the way a consumer
// would and exercises it. The tarball is mounted read-only at /pkg; the
// install happens in the container's own filesystem, so nothing built on the
// host (a macOS node_modules, a host-generated engine) can leak in.
//
// DATABASE_URL (a throwaway database created by the host script) arrives in
// the environment only. Nothing here prints it; every captured output is
// masked before it is reported.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tarball = process.argv[2];
const expectedVersion = process.argv[3];
const work = "/work";
const forbidden = ["prisma", "@prisma/config", "deepmerge-ts", "mysql2"];
const mask = (text) => String(text ?? "").replace(/postgres(ql)?:\/\/[^\s`'"]+/gi, "<database url>");
const npmEnv = { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" };

function fail(message, output) {
  console.error(`ACCEPTANCE FAILURE: ${message}${output ? `\n${mask(output).trim()}` : ""}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: work, encoding: "utf8", env: npmEnv, ...options });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
    stdout: result.stdout ?? "",
  };
}

mkdirSync(work, { recursive: true });
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "wardby-consumer", private: true }));
const install = run("npm", ["install", "--no-audit", "--no-fund", tarball]);
if (install.status !== 0) fail("npm install of the packed tarball failed", install.output);

const wardby = join(work, "node_modules", ".bin", "wardby");
const help = run(wardby, ["--help"]);
if (help.status !== 0 || !help.stdout.includes("wardby quickstart") || !help.stdout.includes("wardby doctor")) {
  fail("installed wardby --help output is incomplete", help.output);
}
const version = run(wardby, ["--version"]).stdout.trim();
if (version !== expectedVersion) fail(`installed version ${version} does not match package ${expectedVersion}`);

// An unreachable database must fail fast with a connection error, not a
// missing-module / uninitialized-client error, and not hang (pg's own default
// is to wait forever; src/core/db.ts bounds it).
const probeStart = Date.now();
const probe = run(wardby, ["agent", "list"], {
  env: { ...npmEnv, DATABASE_URL: "postgresql://wardby:wardby@127.0.0.1:1/wardby?connect_timeout=1" },
  timeout: 60_000,
});
const probeSeconds = (Date.now() - probeStart) / 1000;
const brokenRuntime = [
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "Cannot find module",
  "Cannot find package",
  "did not initialize yet",
];
if (brokenRuntime.some((message) => probe.output.includes(message))) {
  fail("installed Prisma runtime is incomplete", probe.output);
}
if (probe.status === 0) fail("agent list against an unreachable database unexpectedly succeeded");
if (!/ECONNREFUSED|connect|reach/i.test(probe.output))
  fail("unreachable database gave no connection error", probe.output);
if (probeSeconds > 20) fail(`unreachable database took ${probeSeconds}s to fail`);

// The consumer tree must not carry the Prisma CLI or its dependencies.
const tree = JSON.parse(run("npm", ["ls", "--all", "--json"]).stdout || "{}");
const found = new Set();
(function walk(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    // An unmet optional peer (@prisma/client declares `prisma` as one) is
    // listed without a version; only installed packages count.
    if (forbidden.includes(name) && child.version) found.add(`${name}@${child.version}`);
    walk(child);
  }
})(tree);
if (found.size > 0) fail(`installed tree contains ${[...found].join(", ")}`);
for (const name of forbidden) {
  const onDisk = run("find", ["node_modules", "-path", `*/node_modules/${name}/package.json`]).stdout.trim();
  if (onDisk) fail(`installed tree contains ${name} on disk`, onDisk);
}

const auditRun = run("npm", ["audit", "--json"]);
const audit = JSON.parse(auditRun.stdout || "{}");
const counts = audit.metadata?.vulnerabilities;
if (!counts) fail("npm audit returned no report", auditRun.output);
if ((counts.high ?? 0) + (counts.critical ?? 0) > 0) {
  fail(`npm audit reports ${counts.high} high / ${counts.critical} critical`, auditRun.stdout);
}

// Quickstart's migration path, exactly as quickstart/doctor call it: the pinned
// Prisma CLI via npx with the config shipped in the package.
const migrateModule = join(work, "node_modules", "@wardby", "cli", "dist", "quickstart", "migrate.js");
const { runPrismaMigrate, PRISMA_CLI_VERSION } = await import(migrateModule);
const deploy = runPrismaMigrate("deploy", process.env, work);
if (deploy.status !== 0) fail("quickstart migrate deploy failed", `${deploy.stdout}\n${deploy.stderr}`);
const status = runPrismaMigrate("status", process.env, work);
if (status.status !== 0 || !status.stdout.includes("Database schema is up to date")) {
  fail("quickstart migrate status is not clean", `${status.stdout}\n${status.stderr}`);
}

const list = run(wardby, ["agent", "list"], { timeout: 60_000 });
if (list.status !== 0) fail("wardby agent list against the migrated database failed", list.output);

const applied = (deploy.stdout.match(/^\s*[└├]─ \S+\/$/gm) ?? []).length;
console.log(
  `ACCEPTANCE RESULT ${JSON.stringify({
    arch: execFileSync("uname", ["-m"], { encoding: "utf8" }).trim(),
    node: process.version,
    version,
    probeSeconds,
    probeError: mask(
      probe.output
        .trim()
        .split("\n")
        .find((line) => /ECONNREFUSED|connect|reach/i.test(line)),
    ),
    forbiddenFound: [...found],
    audit: counts,
    prismaCli: PRISMA_CLI_VERSION,
    migrationsApplied: applied,
    deployTail: mask(deploy.stdout).trim().split("\n").slice(-3),
    statusTail: mask(status.stdout).trim().split("\n").slice(-2),
    agentList: mask(list.stdout).trim().split("\n").slice(0, 3),
  })}`,
);
