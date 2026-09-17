import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const compose = readFileSync(fileURLToPath(new URL("../deploy/production/compose.yml", import.meta.url)), "utf8");
const caddyfile = readFileSync(fileURLToPath(new URL("../deploy/production/Caddyfile", import.meta.url)), "utf8");

function service(name) {
  const start = compose.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `Missing ${name} service.`);
  const rest = compose.slice(start + 1);
  const nextService = rest.search(/\n {2}[a-z][a-z-]*:\n/);
  return compose.slice(start, nextService === -1 ? compose.length : start + 1 + nextService);
}

const edge = service("edge");
assert.match(edge, /ports:\n {6}- "80:80"\n {6}- "443:443"/, "Only the edge must publish HTTPS ports.");

for (const name of ["mcp", "scheduler", "migrate"]) {
  const definition = service(name);
  assert.doesNotMatch(definition, /\n {4}ports:/, `${name} must not publish a host port.`);
  assert.match(definition, /read_only: true/, `${name} must have a read-only root filesystem.`);
  assert.match(definition, /user: "1000:1000"/, `${name} must run as the runtime-image user.`);
  assert.match(definition, /cap_drop:\n {6}- ALL/, `${name} must drop Linux capabilities.`);
  assert.match(definition, /no-new-privileges:true/, `${name} must prevent privilege escalation.`);
}

assert.match(service("mcp"), /expose:\n {6}- "8080"/, "MCP must expose its private port to the edge.");
assert.match(
  service("migrate"),
  /DATABASE_URL: \$\{MIGRATION_DATABASE_URL:\?Set MIGRATION_DATABASE_URL/,
  "Migrations must use a dedicated database role.",
);
assert.match(caddyfile, /\{\$MCP_PUBLIC_HOST\} \{/, "Caddy must serve only the configured canonical host.");
assert.match(caddyfile, /header_up Host \{\$MCP_PUBLIC_HOST\}/, "Caddy must normalize the upstream Host.");
assert.match(caddyfile, /max_size 1MB/, "Caddy must enforce an edge request-body limit.");

console.log(JSON.stringify({ result: "PASS", assertions: 24 }));
