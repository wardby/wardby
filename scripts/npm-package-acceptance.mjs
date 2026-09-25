import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenvFlow from "dotenv-flow";
import pg from "pg";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
// The database the consumer install runs against. The URL is only used to
// create and drop one throwaway database (wardby_package_<random>) beside it;
// it is never printed. WARDBY_PACKAGE_TEST_DATABASE_URL wins, then the shell's
// DATABASE_URL, then the same env files the test suite loads.
function testDatabaseUrl() {
  const fromFiles = dotenvFlow.parse(
    [".env", ".env.local", ".env.test", ".env.test.local"]
      .map((file) => join(projectRoot, file))
      .filter((file) => existsSync(file)),
  );
  const url = process.env.WARDBY_PACKAGE_TEST_DATABASE_URL || process.env.DATABASE_URL || fromFiles.DATABASE_URL;
  if (!url) throw new Error("package acceptance needs a PostgreSQL URL (DATABASE_URL) to create a throwaway database");
  return url;
}

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
    "bin/wardby.js",
    "dist/wardby-bin.js",
    "dist/cli.js",
    "prisma/schema.prisma",
    "prisma/migrate.config.mjs",
    "dist/generated/prisma/client.js",
    "dist/quickstart/migrate.js",
    "deploy/local/docker-compose.yml",
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

  // Consumer install + run, inside a clean linux/amd64 container: portability
  // is proven on the platform the images and most servers use, not on the
  // machine that built the tarball. Same pinned node image as deploy/Dockerfile.
  const nodeImage = /^FROM (\S+)/m.exec(readFileSync(join(projectRoot, "deploy/Dockerfile"), "utf8"))?.[1];
  if (!nodeImage) throw new Error("could not read the node base image from deploy/Dockerfile");
  // Tagged through a one-line build rather than `docker run <image@digest>`:
  // Docker Desktop's containerd store refuses to run a digest-pinned reference
  // for a non-native platform ("cannot overwrite digest"), while builds of the
  // same pinned FROM work.
  const consumerImage = "wardby-package-acceptance-node:local";
  run("docker", ["build", "--quiet", "--platform", "linux/amd64", "--tag", consumerImage, "-"], {
    input: `FROM ${nodeImage}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const adminUrl = testDatabaseUrl();
  const databaseName = `wardby_package_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const containerUrl = new URL(adminUrl);
    containerUrl.pathname = `/${databaseName}`;
    if (["localhost", "127.0.0.1", "[::1]"].includes(containerUrl.hostname)) {
      containerUrl.hostname = "host.docker.internal";
    }
    // The URL reaches the container through the environment (`-e DATABASE_URL`
    // with no value copies it from docker's own env), never through argv.
    const container = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        "DATABASE_URL",
        "-v",
        `${scratch}:/pkg:ro`,
        "-v",
        `${join(projectRoot, "scripts/npm-package-acceptance-harness.mjs")}:/harness.mjs:ro`,
        consumerImage,
        "node",
        "/harness.mjs",
        `/pkg/${packed.filename}`,
        packageJson.version,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DATABASE_URL: containerUrl.toString() },
        timeout: 15 * 60_000,
      },
    );
    const output = `${container.stdout ?? ""}\n${container.stderr ?? ""}`.replace(
      /postgres(ql)?:\/\/[^\s`'"]+/gi,
      "<database url>",
    );
    const result = /^ACCEPTANCE RESULT (.*)$/m.exec(output);
    if (container.status !== 0 || !result) {
      throw new Error(`linux/amd64 consumer install failed:\n${output.trim()}`);
    }
    console.log(JSON.stringify(JSON.parse(result[1]), null, 2));
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }

  console.log(`package acceptance passed for ${packed.filename} (${packed.size} bytes)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
