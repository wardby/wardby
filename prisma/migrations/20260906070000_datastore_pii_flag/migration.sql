-- Opt-in per-entry PII encryption for the datastore seam. Additive: two new
-- columns on DatastoreEntry, both defaulted so every existing row keeps its
-- current (unencrypted) behavior. `pii` is only ever set true by an explicit
-- `datastore.set(..., { pii: true })` call -- never inferred or backfilled.
ALTER TABLE "DatastoreEntry" ADD COLUMN "pii" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DatastoreEntry" ADD COLUMN "keyId" TEXT;
