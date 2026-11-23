import { describe, expect, it } from "vitest";
import {
  declaredEntries,
  MAX_SERVICE_DECLARATION_BYTES,
  ServiceDeclarationError,
  parseServiceDeclaration,
} from "./declaration.js";

function reasonOf(text: string): string {
  try {
    parseServiceDeclaration(text);
  } catch (error) {
    if (error instanceof ServiceDeclarationError) return error.reason;
    throw error;
  }
  throw new Error("expected the declaration to be refused");
}

describe("parseServiceDeclaration", () => {
  it("reads the documented example, comments included", () => {
    const text = [
      "# Services wardby starts next to coding runs for this repository.",
      "services:",
      '  postgres: "16"',
      '  redis: "7"   # a cache for the session tests',
      "",
    ].join("\n");
    expect(parseServiceDeclaration(text)).toEqual({
      services: [
        { name: "postgres", version: "16" },
        { name: "redis", version: "7" },
      ],
    });
  });

  it("accepts bare and single-quoted versions and keeps every version a string", () => {
    expect(parseServiceDeclaration("services:\n    mysql: 8.0\n    postgres: '16'\n")).toEqual({
      services: [
        { name: "mysql", version: "8.0" },
        { name: "postgres", version: "16" },
      ],
    });
  });

  it("tolerates CRLF line endings and a byte-order mark", () => {
    expect(parseServiceDeclaration('﻿services:\r\n  postgres: "16"\r\n')).toEqual({
      services: [{ name: "postgres", version: "16" }],
    });
  });

  it("reads an empty list as no services", () => {
    expect(parseServiceDeclaration("services:\n")).toEqual({ services: [] });
    expect(parseServiceDeclaration("services: {}\n")).toEqual({ services: [] });
  });

  it("reads a toolchain with services, in either order", () => {
    const expected = {
      toolchain: { name: "python-dev", version: "3.13" },
      services: [{ name: "postgres", version: "16" }],
    };
    expect(parseServiceDeclaration("toolchain:\n  python-dev: 3.13\nservices:\n  postgres: 16\n")).toEqual(expected);
    expect(parseServiceDeclaration("services:\n    postgres: 16\ntoolchain:\n  python-dev: '3.13'\n")).toEqual(
      expected,
    );
  });

  it("reads a toolchain alone, with no services key", () => {
    expect(parseServiceDeclaration('# our dev image\ntoolchain:\n  python-dev: "3.13"\n')).toEqual({
      toolchain: { name: "python-dev", version: "3.13" },
      services: [],
    });
  });

  it("counts the toolchain toward the service limit", () => {
    const text = `toolchain:\n  dev: "1"\nservices:\n${["a", "b", "c", "d", "e"].map((n) => `  ${n}: "1"`).join("\n")}\n`;
    expect(reasonOf(text)).toBe("it lists more than 5 services");
  });

  it.each([
    ["no services key", "# nothing here\n", "it has no `services:`, `toolchain:` or `setup:` key"],
    [
      "another top-level key",
      'services:\n  postgres: "16"\nimage: evil\n',
      "line 3: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    [
      "a second services key",
      "services:\nservices:\n",
      "line 2: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    [
      "a document marker",
      '---\nservices:\n  postgres: "16"\n',
      "line 1: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    [
      "a flow mapping",
      'services: {postgres: "16"}\n',
      "line 1: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    [
      "a second toolchain key",
      'toolchain:\n  dev: "1"\ntoolchain:\n  other: "1"\n',
      "line 3: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    ["two toolchains", 'toolchain:\n  dev: "1"\n  other: "1"\n', "line 3: `toolchain:` takes exactly one entry"],
    ["an empty toolchain", "toolchain:\n", "`toolchain:` takes exactly one entry"],
    ["an empty flow toolchain", "toolchain: {}\nservices:\n", "`toolchain:` takes exactly one entry"],
    [
      "the toolchain's name again under services",
      'toolchain:\n  dev: "1"\nservices:\n  dev: "2"\n',
      "line 4: `dev` is listed twice",
    ],
    [
      "an entry before services",
      '  postgres: "16"\nservices:\n',
      "line 1: entries must sit under `services:`, `toolchain:` or `setup:`",
    ],
    ["tabs", 'services:\n\tpostgres: "16"\n', "line 2: use spaces, not tabs"],
    [
      "a nested value",
      "services:\n  postgres:\n    version: 16\n",
      'line 2: expected `name: version`, like `postgres: "16"`',
    ],
    [
      "uneven indentation",
      'services:\n  postgres: "16"\n    redis: "7"\n',
      "line 3: every service must use the same indentation",
    ],
    [
      "an upper-case name",
      'services:\n  Postgres: "16"\n',
      "line 2: a service name must be lowercase letters, digits and hyphens, starting with a letter",
    ],
    [
      "an anchor",
      'services:\n  postgres: &pg "16"\n',
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    [
      "a tag",
      "services:\n  postgres: !!str 16\n",
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    [
      "a list value",
      "services:\n  postgres: [16]\n",
      'line 2: the version for `postgres` must be a short string like "16"',
    ],
    ["a duplicate", 'services:\n  postgres: "16"\n  postgres: "15"\n', "line 3: `postgres` is listed twice"],
    [
      "six services",
      `services:\n${["a", "b", "c", "d", "e", "f"].map((n) => `  ${n}: "1"`).join("\n")}\n`,
      "it lists more than 5 services",
    ],
    ["a control character", 'services:\n  postgres: "16"\u0007\n', "line 2: control characters are not allowed"],
  ])("refuses %s", (_label, text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it("reads setup jobs in declaration order, before or after services", () => {
    const expected = {
      services: [{ name: "mysql", version: "8" }],
      setup: [
        { name: "app-migrations", version: "1" },
        { name: "search-mappings", version: "1" },
      ],
    };
    expect(
      parseServiceDeclaration('services:\n  mysql: "8"\nsetup:\n  app-migrations: "1"\n  search-mappings: "1"\n'),
    ).toEqual(expected);
    expect(
      parseServiceDeclaration("setup:\n    app-migrations: 1\n    search-mappings: '1'\nservices:\n  mysql: 8\n"),
    ).toEqual(expected);
    expect(declaredEntries(expected)).toEqual([
      { name: "mysql", version: "8" },
      { name: "app-migrations", version: "1" },
      { name: "search-mappings", version: "1" },
    ]);
  });

  it("reads setup jobs alongside a toolchain, and without a services key", () => {
    expect(parseServiceDeclaration('toolchain:\n  dev: "1"\nsetup:\n  seed: "1"\n')).toEqual({
      toolchain: { name: "dev", version: "1" },
      services: [],
      setup: [{ name: "seed", version: "1" }],
    });
  });

  it("leaves setup out when its key is empty", () => {
    expect(parseServiceDeclaration('services:\n  mysql: "8"\nsetup:\n')).toEqual({
      services: [{ name: "mysql", version: "8" }],
    });
  });

  it("allows four setup jobs beside five services: the caps are separate", () => {
    const text = `services:\n${["a", "b", "c", "d", "e"].map((n) => `  ${n}: "1"`).join("\n")}\nsetup:\n${["s1", "s2", "s3", "s4"].map((n) => `  ${n}: "1"`).join("\n")}\n`;
    const declaration = parseServiceDeclaration(text);
    expect(declaration.services).toHaveLength(5);
    expect(declaration.setup?.map((job) => job.name)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it.each([
    [
      "five setup jobs",
      `setup:\n${["s1", "s2", "s3", "s4", "s5"].map((n) => `  ${n}: "1"`).join("\n")}\n`,
      "it lists more than 4 setup jobs",
    ],
    [
      "a second setup key",
      'setup:\n  a: "1"\nsetup:\n  b: "1"\n',
      "line 3: the only top-level keys allowed are `services`, `toolchain` and `setup`, each once",
    ],
    [
      "a setup job's name again under services",
      'services:\n  db: "1"\nsetup:\n  db: "2"\n',
      "line 4: `db` is listed twice",
    ],
    [
      "a nested setup value",
      "setup:\n  migrate:\n    command: x\n",
      'line 2: expected `name: version`, like `postgres: "16"`',
    ],
  ])("refuses %s", (_label, text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it("refuses a file over the size cap", () => {
    const text = `services:\n${"#".repeat(MAX_SERVICE_DECLARATION_BYTES)}\n`;
    expect(reasonOf(text)).toBe(`it is larger than ${MAX_SERVICE_DECLARATION_BYTES} bytes`);
  });

  it("never echoes a name that failed validation", () => {
    const reason = reasonOf('services:\n  "<img src=x>": "16"\n');
    expect(reason).not.toContain("<img");
  });

  it("carries the reason in the error message for the operator log", () => {
    expect(() => parseServiceDeclaration("image: x\n")).toThrow("service_declaration_invalid: line 1:");
  });
});
