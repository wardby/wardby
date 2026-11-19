-- Request attempts: a retry may take over a request whose proxy died, as a new row of the same
-- requestKey with the next attempt number. The old row stays, settled, as the record of the first try.

ALTER TABLE "CodingProxyRequest" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "CodingProxyRequest_sessionId_requestKey_key";

CREATE UNIQUE INDEX "CodingProxyRequest_sessionId_requestKey_attempt_key"
    ON "CodingProxyRequest"("sessionId", "requestKey", "attempt");
