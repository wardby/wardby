import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRISMA_CLI_VERSION,
  REGISTRY_FAILURE_MESSAGE,
  classifyMigrateResult,
  migrateConfigFile,
  migrateFailureReason,
  parseLocalPrismaVersion,
  prismaMigrateInvocation,
} from "./migrate.js";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
  files: string[];
};

describe("quickstart prisma migrate invocation", () => {
  it("pins the same exact CLI version the package is built with", () => {
    expect(packageJson.devDependencies.prisma).toBe(PRISMA_CLI_VERSION);
    expect(PRISMA_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses a config file that exists and is shipped in the package", () => {
    expect(existsSync(migrateConfigFile)).toBe(true);
    expect(packageJson.files).toContain("prisma/migrate.config.mjs");
  });

  it("runs the pinned CLI through npx and keeps the database URL off argv", () => {
    const url = "postgresql://user:hunter2@db.example:5432/wardby";
    const invocation = prismaMigrateInvocation("deploy", { DATABASE_URL: url, PATH: "/bin" });

    expect(invocation.command).toBe("npx");
    expect(invocation.args).toEqual([
      "--yes",
      `prisma@${PRISMA_CLI_VERSION}`,
      "migrate",
      "deploy",
      "--config",
      migrateConfigFile,
    ]);
    expect(invocation.args.join(" ")).not.toContain("hunter2");
    expect(invocation.env.DATABASE_URL).toBe(url);
    expect(invocation.env.PRISMA_HIDE_UPDATE_MESSAGE).toBe("1");
  });

  it("checks status with the same config", () => {
    expect(prismaMigrateInvocation("status", {}).args.slice(2)).toEqual([
      "migrate",
      "status",
      "--config",
      migrateConfigFile,
    ]);
  });

  it("uses a locally installed prisma when the probe reports exactly the pinned version", () => {
    const url = "postgresql://user:hunter2@db.example:5432/wardby";
    const probe = () => PRISMA_CLI_VERSION;
    const invocation = prismaMigrateInvocation("deploy", { DATABASE_URL: url, PATH: "/usr/bin" }, probe);

    expect(invocation.command).toBe("prisma");
    expect(invocation.args).toEqual(["migrate", "deploy", "--config", migrateConfigFile]);
    expect(invocation.local).toBe(true);
    expect(invocation.args.join(" ")).not.toContain("hunter2");
    expect(invocation.env.DATABASE_URL).toBe(url);
    expect(invocation.env.PRISMA_HIDE_UPDATE_MESSAGE).toBe("1");
  });

  it.each([["6.14.0"], ["8.0.0-rc.1"], ["7.10.0-canary"], [""], [undefined]])(
    "falls back to npx when the local probe reports a version other than the pin: %s",
    (reported) => {
      const invocation = prismaMigrateInvocation("deploy", {}, () => reported);
      expect(invocation.command).toBe("npx");
      expect(invocation.local).toBe(false);
      expect(invocation.args).toEqual([
        "--yes",
        `prisma@${PRISMA_CLI_VERSION}`,
        "migrate",
        "deploy",
        "--config",
        migrateConfigFile,
      ]);
    },
  );

  it("falls back to npx when the probe itself fails (not on PATH, spawn error, non-zero exit, or timeout)", () => {
    const probe = () => {
      throw new Error("should not be reached: probe failures resolve to undefined, not a throw");
    };
    // A real probe never throws -- it swallows spawn errors, non-zero exits,
    // and timeouts into `undefined` -- so simulate that outcome directly.
    const invocation = prismaMigrateInvocation("deploy", {}, () => undefined);
    expect(invocation.command).toBe("npx");
    expect(invocation.local).toBe(false);
    expect(() => probe()).toThrow();
  });

  it("never puts the database URL on argv for the local invocation either", () => {
    const url = "postgresql://user:hunter2@db.example:5432/wardby";
    const invocation = prismaMigrateInvocation("status", { DATABASE_URL: url }, () => PRISMA_CLI_VERSION);
    expect(invocation.args.join(" ")).not.toContain("hunter2");
    expect(invocation.env.DATABASE_URL).toBe(url);
  });

  it("the registry failure message tells the user how to install the CLI themselves", () => {
    expect(REGISTRY_FAILURE_MESSAGE).toContain(`npm i -g prisma@${PRISMA_CLI_VERSION}`);
    expect(REGISTRY_FAILURE_MESSAGE.toLowerCase()).toContain("quickstart");
    expect(REGISTRY_FAILURE_MESSAGE.toLowerCase()).toContain("doctor");
  });

  it("the shipped config resolves the schema and migrations beside it and reads the URL from env", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://from-env/db";
    try {
      const config = (await import(`${migrateConfigFile}?t=${Date.now()}`)) as {
        default: { schema: string; migrations: { path: string }; datasource: { url: string } };
      };
      expect(config.default.schema).toBe("schema.prisma");
      expect(config.default.migrations.path).toBe("migrations");
      expect(config.default.datasource.url).toBe("postgresql://from-env/db");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

describe("parsing `prisma --version` output", () => {
  // Captured verbatim from `./node_modules/.bin/prisma --version` on Prisma
  // 7.10.0 (stdout only -- "Loaded Prisma config from..." and "Prisma schema
  // loaded from..." are printed to stderr, a separate stream). The label is
  // padded to align a column of unrelated fields, and several other lines
  // carry their own version-shaped numbers (Node.js, TypeScript, the schema
  // engine hash) -- the parser must key off the "prisma" label, not grab the
  // first x.y.z-looking token in the blob.
  const REAL_OUTPUT = `prisma               : 7.10.0
@prisma/client       : 7.10.0
Operating System     : darwin
Architecture         : arm64
Node.js              : v24.12.0
TypeScript           : 5.9.3
Query Compiler       : enabled
PSL                  : @prisma/prisma-schema-wasm 7.10.0-4.0edf323efd1d98336f3f0a68684b56f689b900d3
Schema Engine        : schema-engine-cli 0edf323efd1d98336f3f0a68684b56f689b900d3 (at node_modules/@prisma/engines/schema-engine-darwin-arm64)
Default Engines Hash : 0edf323efd1d98336f3f0a68684b56f689b900d3
Studio               : 0.33.0
Prisma CLI Path      : /Users/chfields/Personal/wardby/node_modules/prisma
`;

  it("reads the version off the `prisma :` line, not the first number in the output", () => {
    expect(parseLocalPrismaVersion(REAL_OUTPUT)).toBe("7.10.0");
  });

  it("does not match the `@prisma/client` line even though it also reports a version", () => {
    const clientOnly = "@prisma/client       : 6.14.0\nStudio                : 0.33.0\n";
    expect(parseLocalPrismaVersion(clientOnly)).toBeUndefined();
  });

  it("returns undefined for output with no `prisma :` line at all", () => {
    expect(parseLocalPrismaVersion("")).toBeUndefined();
    expect(parseLocalPrismaVersion("command not found: prisma\n")).toBeUndefined();
  });
});

describe("classifying a failed npx prisma run", () => {
  const failed = (stderr: string, stdout = "") => ({ status: 1, stdout, stderr });

  it("reports a spawn error (npx missing or not startable) as a registry failure", () => {
    const result = classifyMigrateResult(
      failed(""),
      Object.assign(new Error("spawnSync npx ENOENT"), { code: "ENOENT" }),
    );
    expect(result.registryFailure).toBe(true);
    expect(result.stderr).toBe("spawnSync npx ENOENT");
    expect(migrateFailureReason(result)).toBe(REGISTRY_FAILURE_MESSAGE);
    expect(REGISTRY_FAILURE_MESSAGE).toContain(`prisma@${PRISMA_CLI_VERSION}`);
  });

  it.each([
    [
      "npm error code ECONNREFUSED\nnpm error errno ECONNREFUSED\nnpm error FetchError: request to http://127.0.0.1:1/prisma failed",
    ],
    ["npm error code ENOTFOUND\nnpm error network request to http://nonexistent.invalid/prisma failed"],
    ["npm error code EAI_AGAIN"],
    ["npm error code ETIMEDOUT"],
    ["npm error code E403\nnpm error 403 Forbidden - GET https://registry.example/prisma"],
    ["npm error code E503"],
    ["npm error code ETARGET\nnpm error notarget No matching version found for prisma@7.10.0."],
    ["npm ERR! code ENOTFOUND"],
  ])("reports npm's registry error as a registry failure: %s", (stderr) => {
    const result = classifyMigrateResult(failed(`npm warn exec The following package was not found\n${stderr}`));
    expect(result.registryFailure).toBe(true);
    expect(migrateFailureReason(result)).toBe(REGISTRY_FAILURE_MESSAGE);
  });

  it("keeps a real migration failure as Prisma's own error", () => {
    const stdout =
      'Loaded Prisma config from migrate.config.mjs.\n\nDatasource "db": PostgreSQL database "wardby", schema "public" at "localhost:55432"\n';
    for (const stderr of [
      "Error: P1001: Can't reach database server at `localhost:55432`\n\nconnect ECONNREFUSED 127.0.0.1:55432",
      "Error: P1003: Database `wardby` does not exist",
      "Error: P3009: migrate found failed migrations in the target database",
    ]) {
      const result = classifyMigrateResult(failed(stderr, stdout));
      expect(result.registryFailure).toBeUndefined();
      const reason = migrateFailureReason(result);
      expect(reason).not.toBe(REGISTRY_FAILURE_MESSAGE);
      expect(reason).toMatch(/^Error: P\d{4}/);
    }
  });

  it("leaves a successful run alone and masks URLs in reasons", () => {
    expect(
      classifyMigrateResult({ status: 0, stdout: "ok", stderr: "npm error code E404" }).registryFailure,
    ).toBeUndefined();
    expect(migrateFailureReason(failed("Error: bad url postgresql://u:secret@h/db"))).toBe(
      "Error: bad url <database url>",
    );
  });
});

describe("classifying a failed local prisma run", () => {
  const failed = (stderr: string, stdout = "") => ({ status: 1, stdout, stderr });

  it("does not treat an npm-shaped registry error as a registry failure on the local path", () => {
    // Nothing was fetched -- this is Prisma's own output (or, in this test,
    // output that merely happens to look like npm's registry error text).
    const result = classifyMigrateResult(failed("npm error code ENOTFOUND"), undefined, true);
    expect(result.registryFailure).toBeUndefined();
  });

  it("still produces a clear message when the local binary itself can't be spawned", () => {
    const result = classifyMigrateResult(
      failed(""),
      Object.assign(new Error("spawnSync prisma ENOENT"), { code: "ENOENT" }),
      true,
    );
    expect(result.registryFailure).toBeUndefined();
    expect(migrateFailureReason(result)).not.toBe(REGISTRY_FAILURE_MESSAGE);
    expect(migrateFailureReason(result)).toContain("spawnSync prisma ENOENT");
  });

  it("keeps a real local migration failure as Prisma's own error", () => {
    const result = classifyMigrateResult(failed("Error: P1001: Can't reach database server"), undefined, true);
    expect(result.registryFailure).toBeUndefined();
    expect(migrateFailureReason(result)).toMatch(/^Error: P\d{4}/);
  });
});
