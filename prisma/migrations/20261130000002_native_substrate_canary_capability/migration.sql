-- Native sandbox on Substrate: each startup canary reports with its own one-use capability, held only
-- by its Secret. The row keeps the capability's SHA-256 hex; rows from before this take no report.
ALTER TABLE "NativeSubstrateCanary" ADD COLUMN "capabilityHash" TEXT;
