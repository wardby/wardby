-- Cache-aware holds: per-request size, ceiling, basis and conversation key.

ALTER TABLE "CodingProxyRequest" ADD COLUMN "requestBytes" INTEGER;
ALTER TABLE "CodingProxyRequest" ADD COLUMN "ceilingUsd" DECIMAL(18,10);
ALTER TABLE "CodingProxyRequest" ADD COLUMN "reservationBasis" TEXT;
ALTER TABLE "CodingProxyRequest" ADD COLUMN "conversationKey" TEXT;

CREATE INDEX "CodingProxyRequest_sessionId_conversationKey_idx"
    ON "CodingProxyRequest"("sessionId", "conversationKey");
