-- Named/shared datastores: a Datastore resource attached to agents via
-- AgentDatastore (boundName convention, mirrors AgentSecret), and
-- DatastoreEntry's keyspace unified to carry both private (agentId) and
-- shared (datastoreId) rows. Purely additive; no existing row is touched
-- beyond the agentId nullability relaxation (every existing row already has
-- agentId set, so this changes no data).

CREATE TABLE "Datastore" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Datastore_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Datastore_ownerId_name_key" ON "Datastore" ("ownerId", "name");
ALTER TABLE "Datastore" ADD CONSTRAINT "Datastore_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentDatastore" (
  "agentId" TEXT NOT NULL,
  "datastoreId" TEXT NOT NULL,
  "boundName" TEXT NOT NULL,

  CONSTRAINT "AgentDatastore_pkey" PRIMARY KEY ("agentId", "datastoreId")
);
CREATE UNIQUE INDEX "AgentDatastore_agentId_boundName_key" ON "AgentDatastore" ("agentId", "boundName");
ALTER TABLE "AgentDatastore" ADD CONSTRAINT "AgentDatastore_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentDatastore" ADD CONSTRAINT "AgentDatastore_datastoreId_fkey"
  FOREIGN KEY ("datastoreId") REFERENCES "Datastore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unify DatastoreEntry's keyspace: agentId becomes nullable, datastoreId is
-- added nullable. Existing rows keep agentId set / datastoreId null, so
-- their behavior is unchanged.
--
-- The old (agentId, key) primary key must be dropped before agentId's NOT
-- NULL can be relaxed — Postgres refuses ALTER COLUMN ... DROP NOT NULL on a
-- column that is still part of a primary key (42P16). Replaced below by two
-- scoped unique indexes: a datastoreId-scoped row has a null agentId, so the
-- old PK can't hold anyway. Postgres unique indexes treat NULL as distinct
-- from NULL, so many datastoreId-scoped rows (all agentId = NULL) never
-- collide on the first index, and vice versa.
ALTER TABLE "DatastoreEntry" DROP CONSTRAINT "DatastoreEntry_pkey";
ALTER TABLE "DatastoreEntry" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "DatastoreEntry" ADD COLUMN "datastoreId" TEXT;
ALTER TABLE "DatastoreEntry" ADD CONSTRAINT "DatastoreEntry_datastoreId_fkey"
  FOREIGN KEY ("datastoreId") REFERENCES "Datastore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DatastoreEntry" ADD CONSTRAINT "DatastoreEntry_scope_xor"
  CHECK (("agentId" IS NOT NULL) <> ("datastoreId" IS NOT NULL));
CREATE UNIQUE INDEX "DatastoreEntry_agentId_key_key" ON "DatastoreEntry" ("agentId", "key");
CREATE UNIQUE INDEX "DatastoreEntry_datastoreId_key_key" ON "DatastoreEntry" ("datastoreId", "key");

-- Surrogate primary key required by Prisma's schema validator: once agentId
-- and datastoreId are both optional, neither remaining @@unique has an
-- all-required-fields criterion, and Prisma rejects a model with none
-- (P1012). Backfill uses Postgres 16's built-in gen_random_uuid() (no
-- pgcrypto extension needed) since existing rows predate this column.
ALTER TABLE "DatastoreEntry" ADD COLUMN "id" TEXT;
UPDATE "DatastoreEntry" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;
ALTER TABLE "DatastoreEntry" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "DatastoreEntry" ADD CONSTRAINT "DatastoreEntry_pkey" PRIMARY KEY ("id");

-- Per-attachment capability scoping for shared stores, keyed by boundName —
-- mirrors AgentTool.allowedDatastorePrefixes but as a map, since a tool
-- attachment may be granted access to more than one shared store.
ALTER TABLE "AgentTool" ADD COLUMN "allowedSharedDatastorePrefixes" JSONB NOT NULL DEFAULT '{}';
