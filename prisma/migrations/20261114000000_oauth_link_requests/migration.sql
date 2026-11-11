-- One pending OAuth link per row: account links (host identities) and OAuth secrets share it.
CREATE TABLE "OAuthLinkRequest" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "result" JSONB,
    "payloadCiphertext" TEXT,
    "confirmHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "callbackAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthLinkRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OAuthLinkRequest_stateHash_key" ON "OAuthLinkRequest"("stateHash");
CREATE INDEX "OAuthLinkRequest_principalId_purpose_idx" ON "OAuthLinkRequest"("principalId", "purpose");
CREATE INDEX "OAuthLinkRequest_expiresAt_idx" ON "OAuthLinkRequest"("expiresAt");
ALTER TABLE "OAuthLinkRequest" ADD CONSTRAINT "OAuthLinkRequest_principalId_fkey"
    FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
