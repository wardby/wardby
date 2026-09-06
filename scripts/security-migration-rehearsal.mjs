import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

// Deliberately restricted to the disposable container created for security verification.
const container = "reevo-security-20260906";
const database = "reevo_security";
const schema = "rehearsal_" + Date.now();
const restore = schema + "_restore";
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "reevo", "-d", database], { input: sql, encoding: "utf8" });
const sql = (text, name = schema) => psql('SET search_path TO "' + name + '";\n' + text);
const migrations = readdirSync(new URL("../prisma/migrations/", import.meta.url)).filter((p) => /^\d/.test(p)).sort();
const read = (name) => readFileSync(new URL("../prisma/migrations/" + name + "/migration.sql", import.meta.url), "utf8");
const latest = migrations.pop();
assert.equal(latest, "20260906040000_secure_self_hosted_oauth");
psql('CREATE SCHEMA "' + schema + '";');
try {
  for (const migration of migrations) sql(read(migration));
  sql(`
    INSERT INTO "Principal" (id,subject) VALUES ('p','migration-test');
    INSERT INTO "Agent" (id,name,"systemPrompt",model,"budgetUsd","updatedAt","ownerId") VALUES ('a','agent','prompt','test',1,NOW(),'p');
    INSERT INTO "Tool" (id,name,description,"paramsZod","jsonSchema",code,"updatedAt","ownerId") VALUES ('t','tool','desc','z.object({})','{}','return 1',NOW(),'p');
    INSERT INTO "AgentTool" ("agentId","toolId") VALUES ('a','t');
    INSERT INTO "Run" (id,"agentId",status,trigger,"finalText",turns) VALUES ('r','a','succeeded','manual','answer',2);
    INSERT INTO "DatastoreEntry" ("agentId",key,value,"updatedAt") VALUES ('a','key','{"preserve":true}',NOW());
    INSERT INTO "Secret" (id,name,ciphertext,"keyId","ownerId","updatedAt") VALUES ('s','name','test-ciphertext','test-key','p',NOW());
    INSERT INTO "AgentSecret" ("agentId","secretId") VALUES ('a','s');
    INSERT INTO "Webhook" (id,"agentId","secretHash","ownerId") VALUES ('w','a','hash','p');
    INSERT INTO "Task" (id,kind,"runId","principalId","ttlAt","updatedAt") VALUES ('task','run','r','p',NOW()+INTERVAL '1 day',NOW());
    INSERT INTO "SchedulerLease" (scope,holder,"expiresAt","updatedAt") VALUES ('scope','holder',NOW()+INTERVAL '1 day',NOW());
    INSERT INTO "OAuthClient" ("clientId",metadata,"clientSecret") VALUES ('old-client','{}','legacy-secret');
    INSERT INTO "OAuthGrant" (id,"clientId","principalId",scope,"refreshToken","expiresAt") VALUES ('old-grant','old-client','p','agents:read','legacy-refresh',NOW()+INTERVAL '1 day');
  `);
  const tables = ["Principal", "Agent", "Tool", "AgentTool", "Run", "DatastoreEntry", "Secret", "AgentSecret", "Webhook", "Task", "SchedulerLease"];
  const snapshot = (name) => tables.map((table) => sql('SELECT jsonb_agg(to_jsonb(t)) FROM "' + table + '" t;', name));
  const before = snapshot(schema);
  // Back up unrelated data only. A security rollback must never resurrect compromised OAuth credentials.
  const backup = execFileSync("docker", ["exec", container, "pg_dump", "-U", "reevo", "-d", database, "--schema=" + schema, "--exclude-table=" + schema + '."OAuthClient"', "--exclude-table=" + schema + '."OAuthGrant"', "--no-owner", "--no-privileges"], { encoding: "utf8" });
  sql(read(latest));
  assert.deepEqual(snapshot(schema), before);
  assert.equal(sql('SELECT count(*) FROM "OAuthClient";').trim(), "0");
  assert.equal(sql('SELECT count(*) FROM "OAuthGrant";').trim(), "0");
  assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_schema='" + schema + "' AND column_name IN ('clientSecret','refreshToken');").trim(), "0");
  psql(backup.replaceAll(schema, restore));
  assert.deepEqual(snapshot(restore), before);
  assert.equal(psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='" + restore + "' AND table_name LIKE 'OAuth%';").trim(), "0");
  // Recreate EMPTY legacy placeholders to rehearse re-applying the security migration after recovery.
  sql('CREATE TABLE "OAuthClient" ("clientId" TEXT PRIMARY KEY, metadata JSONB NOT NULL, "clientSecret" TEXT, "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP); CREATE TABLE "OAuthGrant" (id TEXT PRIMARY KEY, "clientId" TEXT, "principalId" TEXT, scope TEXT, "refreshToken" TEXT, "expiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP);', restore);
  sql(read(latest), restore);
  assert.deepEqual(snapshot(restore), before);
  console.log("PASS: 11 unrelated tables preserved; legacy OAuth rows/columns removed; unrelated-data backup restored and re-migrated without credentials (7 assertions).");
} finally {
  psql('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE; DROP SCHEMA IF EXISTS "' + restore + '" CASCADE;');
}
