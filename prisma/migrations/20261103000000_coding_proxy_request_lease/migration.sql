-- Request leases: the owner process, its lease expiry and the output cap, so any proxy replica can
-- prove a reserved request is orphaned (its process died) and settle it.

ALTER TABLE "CodingProxyRequest" ADD COLUMN "maxOutputTokens" INTEGER;
ALTER TABLE "CodingProxyRequest" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "CodingProxyRequest" ADD COLUMN "leaseUntil" TIMESTAMP(3);

CREATE INDEX "CodingProxyRequest_status_leaseUntil_idx"
    ON "CodingProxyRequest"("status", "leaseUntil");
