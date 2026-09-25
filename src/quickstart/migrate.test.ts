import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRISMA_CLI_VERSION,
  REGISTRY_FAILURE_MESSAGE,
  classifyMigrateResult,
  migrateConfigFile,
  migrateFailureReason,
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
