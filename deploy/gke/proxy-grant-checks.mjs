// Reads deploy/gke/database-grants.sql and turns every privilege it grants the
// coding proxy (wardby_proxy) into one SQL query that lists the privileges the
// connected role is still missing. up.sh runs that query inside the proxy pod,
// as the proxy's own IAM user, after a rollout.
//
// Why: the grants only take effect when deploy/gke/bootstrap-database-iam.sh
// runs, and up.sh does not run it. Twice a release added proxy tables whose
// grants were in this file but never applied, and every registry request then
// failed with "permission denied", surfacing only as an unlogged 502 to npm or
// pip. Deriving the checks from the file itself means a new table's grant is
// checked the moment it is written, with no second list to keep in sync.
//
//   node deploy/gke/proxy-grant-checks.mjs          # prints the query
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROLE = "wardby_proxy";

/** Every `EXECUTE format('GRANT ... TO wardby_proxy', args...)` statement, as
 *  { table, privilege, column? } checks (column set for column-level grants). */
export function proxyGrantChecks(sql) {
  const checks = [];
  const statement = /EXECUTE\s+format\(\s*'(GRANT\s[^']*\sTO\s+(\w+))'\s*,([^;]*?)\)\s*;/gs;
  for (const [, template, grantee, rawArgs] of sql.matchAll(statement)) {
    if (grantee !== ROLE) continue;
    const args = [...rawArgs.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    let index = 0;
    const text = template.replace(/%I/g, () => args[index++]);
    const parsed = text.match(/^GRANT\s+(.+?)\s+ON\s+public\.(\w+)\s+TO\s/s);
    if (!parsed) throw new Error(`cannot parse proxy grant: ${text}`);
    const [, privileges, table] = parsed;
    for (const [, privilege, columns] of privileges.matchAll(/(SELECT|INSERT|UPDATE|DELETE)(?:\s*\(([^)]*)\))?/g)) {
      if (!columns) checks.push({ table, privilege });
      else for (const column of columns.split(",")) checks.push({ table, privilege, column: column.trim() });
    }
  }
  return checks;
}

const literal = (value) => `'${value.replaceAll("'", "''")}'`;

/** One query returning a row per privilege the connected role lacks
 *  (none when every grant is applied). */
export function missingGrantsQuery(checks) {
  if (checks.length === 0) throw new Error("no wardby_proxy grants found in database-grants.sql");
  const rows = checks.map(({ table, privilege, column }) => {
    const relation = literal(`public."${table}"`);
    const label = literal(column ? `${privilege} (${column}) ON ${table}` : `${privilege} ON ${table}`);
    const test = column
      ? `has_column_privilege(current_user, ${relation}, ${literal(column)}, ${literal(privilege)})`
      : `has_table_privilege(current_user, ${relation}, ${literal(privilege)})`;
    return `SELECT ${label} AS "grant", ${test} AS ok`;
  });
  return `SELECT "grant" FROM (${rows.join(" UNION ALL ")}) g WHERE NOT ok`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sql = readFileSync(new URL("./database-grants.sql", import.meta.url), "utf8");
  process.stdout.write(`${missingGrantsQuery(proxyGrantChecks(sql))}\n`);
}
