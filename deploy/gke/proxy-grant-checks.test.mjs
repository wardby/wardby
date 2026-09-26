import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingGrantsQuery, proxyGrantChecks } from "./proxy-grant-checks.mjs";

const GRANTS = readFileSync(new URL("./database-grants.sql", import.meta.url), "utf8");

describe("proxyGrantChecks", () => {
  it("covers every table the proxy is granted in database-grants.sql, including column grants", () => {
    const checks = proxyGrantChecks(GRANTS);
    const tables = [...new Set(checks.map((check) => check.table))];
    // Every `TO wardby_proxy` grant on a named table is found, so a table
    // added to the file is checked without touching this module.
    const granted = [...GRANTS.matchAll(/TO wardby_proxy',?[\s\S]*?'(\w+)'\);/g)].map((match) => match[1]);
    expect(tables.sort()).toEqual([...new Set(granted)].sort());
    expect(checks).toContainEqual({ table: "RegistryPlanRefusal", privilege: "INSERT" });
    expect(checks).toContainEqual({ table: "CodingRun", privilege: "SELECT", column: "packageAllowlist" });
    expect(checks).toContainEqual({ table: "Run", privilege: "UPDATE", column: "costUsd" });
    expect(checks).toContainEqual({ table: "Run", privilege: "SELECT", column: "id" });
  });

  it("ignores grants to other roles", () => {
    const sql = `EXECUTE format('GRANT SELECT ON public.%I TO wardby_app', 'Agent');
      EXECUTE format('GRANT INSERT ON public.%I TO wardby_proxy', 'Only');`;
    expect(proxyGrantChecks(sql)).toEqual([{ table: "Only", privilege: "INSERT" }]);
  });
});

describe("missingGrantsQuery", () => {
  it("asks about each privilege with the matching table or column function", () => {
    const query = missingGrantsQuery([
      { table: "RegistryFetch", privilege: "INSERT" },
      { table: "Run", privilege: "UPDATE", column: "costUsd" },
    ]);
    expect(query).toContain(`has_table_privilege(current_user, 'public."RegistryFetch"', 'INSERT')`);
    expect(query).toContain(`has_column_privilege(current_user, 'public."Run"', 'costUsd', 'UPDATE')`);
    expect(query).toContain("WHERE NOT ok");
  });

  it("refuses an empty check list rather than passing vacuously", () => {
    expect(() => missingGrantsQuery([])).toThrow(/no wardby_proxy grants/);
  });
});
