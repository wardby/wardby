import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRISMA_CLI_VERSION, migrateConfigFile, prismaMigrateInvocation } from "./migrate.js";

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
