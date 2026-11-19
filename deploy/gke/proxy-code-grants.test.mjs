// Fails when the coding proxy's production code touches a table, or uses a
// privilege on a table, that deploy/gke/database-grants.sql does not grant
// the wardby_proxy role. A missing grant otherwise shows up only on a
// deployed system, as "permission denied" on every registry request.
//
// No database is needed: the test reads the proxy's sources as text.
//
// What it scans (src/providers/coding-proxy/, production sources only):
//   - Prisma model operations: `db.<model>.<op>(`, `tx.<model>.<op>(`,
//     including `this.db.` and `options.db.`.
//   - Raw SQL in `$queryRaw` / `$executeRaw` template literals: the table after
//     FROM, JOIN, INSERT INTO, UPDATE and DELETE FROM.
// Operation to privilege: find*, count, aggregate, groupBy -> SELECT;
// create, createMany -> INSERT; update, updateMany -> UPDATE;
// upsert -> INSERT and UPDATE; delete, deleteMany -> DELETE.
//
// What it verifies: every table the code uses is granted, with every privilege
// the code uses on it. For a table granted by column (for example
// `GRANT SELECT (a, b)` or `UPDATE (a)`), a privilege counts as granted when
// the file grants it table-wide or on at least one column.
// What it does not verify: which columns. Column-level gaps, the privileges
// Postgres implies (a WHERE clause or RETURNING needs SELECT), sequences and
// schemas are caught only by deploy/gke/database-grants.database.test.mjs,
// which runs the store methods as a member of wardby_proxy against a real database.
//
// Excluded from the scan, because they are not what the deployed proxy runs:
// test files (*.test.ts), test helpers (*.test-support.ts) and the fixtures
// directory. Tests and fixtures create their own agents, runs and coding runs
// as the database owner, which the proxy never does.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { proxyGrantChecks } from "./proxy-grant-checks.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROXY_DIR = join(ROOT, "src/providers/coding-proxy");
const GRANTS_FILE = "deploy/gke/database-grants.sql";
const GRANTS = readFileSync(join(ROOT, GRANTS_FILE), "utf8");
const SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");

const OPERATION_PRIVILEGES = {
  findUnique: ["SELECT"],
  findUniqueOrThrow: ["SELECT"],
  findFirst: ["SELECT"],
  findFirstOrThrow: ["SELECT"],
  findMany: ["SELECT"],
  count: ["SELECT"],
  aggregate: ["SELECT"],
  groupBy: ["SELECT"],
  create: ["INSERT"],
  createMany: ["INSERT"],
  createManyAndReturn: ["INSERT"],
  update: ["UPDATE"],
  updateMany: ["UPDATE"],
  upsert: ["INSERT", "UPDATE"],
  delete: ["DELETE"],
  deleteMany: ["DELETE"],
};

/** Production sources: everything under the proxy directory except tests, test helpers and fixtures. */
function productionSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures") files.push(...productionSources(path));
    } else if (/\.(ts|mjs|js)$/.test(entry.name) && !/\.test(-support)?\.(ts|mjs|js)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Prisma model name (as in `db.<camelCase>`) to its table name, honouring @@map. */
export function modelTables(schema) {
  const tables = new Map();
  for (const [, name, body] of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    tables.set(name[0].toLowerCase() + name.slice(1), mapped ? mapped[1] : name);
  }
  return tables;
}

/** The text of each template literal passed to $queryRaw / $executeRaw (and their Unsafe forms). */
function rawSqlTexts(source) {
  const texts = [];
  for (const match of source.matchAll(/\$(?:query|execute)Raw(?:Unsafe)?\s*(?:<[^`(]*>)?\s*\(?\s*`/g)) {
    let i = match.index + match[0].length;
    let text = "";
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") {
        i++;
      } else if (depth === 0 && c === "`") {
        break;
      } else if (c === "$" && source[i + 1] === "{") {
        depth++;
        i++;
      } else if (depth > 0 && c === "}") {
        depth--;
      } else if (depth === 0) {
        text += c;
      }
    }
    texts.push(text);
  }
  return texts;
}

const RAW_PATTERNS = [
  [/\bDELETE\s+FROM\s+(?:ONLY\s+)?"(\w+)"/gi, "DELETE"],
  [/\bINSERT\s+INTO\s+"(\w+)"/gi, "INSERT"],
  [/\bUPDATE\s+(?:ONLY\s+)?"(\w+)"/gi, "UPDATE"],
  // FROM after DELETE is a delete, not a read; the lookbehind keeps DELETE FROM out of SELECT.
  [/(?<!\bDELETE\s+)\bFROM\s+(?:ONLY\s+)?"(\w+)"/gi, "SELECT"],
  [/\bJOIN\s+"(\w+)"/gi, "SELECT"],
];

/** { table, privilege, where }[] the proxy's production code uses. */
export function usedPrivileges(files, tables) {
  const used = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const where = relative(ROOT, file);
    for (const [, model, operation] of source.matchAll(/\b(?:db|tx)\.([a-z]\w*)\.(\w+)\(/g)) {
      const table = tables.get(model);
      const privileges = OPERATION_PRIVILEGES[operation];
      if (table && privileges)
        for (const privilege of privileges) used.push({ table, privilege, where, via: `${model}.${operation}` });
    }
    for (const text of rawSqlTexts(source)) {
      for (const [pattern, privilege] of RAW_PATTERNS) {
        for (const [, table] of text.matchAll(pattern))
          used.push({ table, privilege, where, via: `raw SQL ${privilege}` });
      }
    }
  }
  return used;
}

/** One line per privilege the code uses that the grants file does not give wardby_proxy. */
export function missingPrivileges(used, granted) {
  const have = new Set(granted.map(({ table, privilege }) => `${table}:${privilege}`));
  const seen = new Set();
  const missing = [];
  for (const { table, privilege, where, via } of used) {
    const key = `${table}:${privilege}`;
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(
      `${privilege} on "${table}" is used by ${where} (${via}) but ${GRANTS_FILE} does not grant it to wardby_proxy. ` +
        `Add it to the grant for "${table}" in ${GRANTS_FILE} (inside the to_regclass block), ` +
        `and to the proxy's grant list in docs/getting-started-gke.md and deploy/gke/README.md.`,
    );
  }
  return missing;
}

describe("the coding proxy's database use is covered by database-grants.sql", () => {
  const tables = modelTables(SCHEMA);
  const used = usedPrivileges(productionSources(PROXY_DIR), tables);
  const granted = proxyGrantChecks(GRANTS);

  it("finds the operations it is meant to scan, so a pass is not vacuous", () => {
    expect(used).toContainEqual(expect.objectContaining({ table: "RegistryReservation", privilege: "DELETE" }));
    expect(used).toContainEqual(expect.objectContaining({ table: "RegistryReservation", privilege: "INSERT" }));
    expect(used).toContainEqual(expect.objectContaining({ table: "RegistryReservation", privilege: "UPDATE" }));
    expect(used).toContainEqual(expect.objectContaining({ table: "RegistryReservation", privilege: "SELECT" }));
    expect(used).toContainEqual(expect.objectContaining({ table: "CodingProxyRequest", privilege: "UPDATE" }));
    expect(used).toContainEqual(expect.objectContaining({ table: "SubstrateRelayEvent", privilege: "DELETE" }));
    expect(used.some((u) => u.where.endsWith("test.ts") || u.where.includes("fixtures"))).toBe(false);
    expect(new Set(used.map((u) => u.table)).size).toBeGreaterThan(10);
  });

  it("grants wardby_proxy every table and privilege the proxy's code uses", () => {
    expect(missingPrivileges(used, granted)).toEqual([]);
  });

  it("reports the table, the privilege and the file to edit when a grant is missing", () => {
    const without = granted.filter((g) => g.table !== "RegistryReservation");
    const [first] = missingPrivileges(used, without);
    expect(first).toMatch(
      /on "RegistryReservation" is used by src\/providers\/coding-proxy\/registry\/prisma-store\.ts/,
    );
    expect(first).toContain(`${GRANTS_FILE} does not grant it to wardby_proxy`);
    const fewer = granted.filter((g) => !(g.table === "RegistryReservation" && g.privilege === "UPDATE"));
    expect(missingPrivileges(used, fewer)).toEqual([expect.stringContaining('UPDATE on "RegistryReservation"')]);
  });

  it("maps model names to table names with @@map", () => {
    expect(
      modelTables(`model RunThing {\n  id String\n  @@map("run_things")\n}\nmodel Plain {\n id String\n}\n`),
    ).toEqual(
      new Map([
        ["runThing", "run_things"],
        ["plain", "Plain"],
      ]),
    );
  });
});
