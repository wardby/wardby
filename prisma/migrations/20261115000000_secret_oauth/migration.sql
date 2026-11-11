-- An OAuth secret's connection metadata and status; null for every other secret.
ALTER TABLE "Secret" ADD COLUMN "oauth" JSONB;
