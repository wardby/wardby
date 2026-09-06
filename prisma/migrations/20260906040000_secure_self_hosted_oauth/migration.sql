-- Hand-written security migration. All legacy OAuth credentials are intentionally invalidated.
-- Deploy only after backup and with issuance stopped. Never restore legacy credential contents.
BEGIN;
DROP TABLE "OAuthGrant";
DROP TABLE "OAuthClient";
CREATE TABLE "OAuthClient" ("clientId" TEXT PRIMARY KEY, "metadata" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "AuthUser" (
  "id" TEXT PRIMARY KEY, "principalId" TEXT NOT NULL, "displayName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'enabled', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthUser_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AuthUser_principalId_key" ON "AuthUser"("principalId");
CREATE TABLE "AuthLoginKey" (
  "keyId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "secretHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastUsedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AuthLoginKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuthLoginKey_userId_idx" ON "AuthLoginKey"("userId");
CREATE INDEX "AuthLoginKey_expiresAt_idx" ON "AuthLoginKey"("expiresAt");
CREATE TABLE "AuthSession" (
  "sessionId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "secretHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE TABLE "AuthFormChallenge" (
  "challengeId" TEXT PRIMARY KEY, "sessionId" TEXT, "purpose" TEXT NOT NULL, "binding" TEXT NOT NULL, "secretHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "AuthFormChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuthFormChallenge_expiresAt_idx" ON "AuthFormChallenge"("expiresAt");
CREATE TABLE "OAuthAuthorizationRequest" (
  "id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "redirectUri" TEXT NOT NULL, "resource" TEXT NOT NULL,
  "requestedScope" TEXT NOT NULL, "codeChallenge" TEXT NOT NULL, "state" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "OAuthAuthorizationRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OAuthAuthorizationRequest_expiresAt_idx" ON "OAuthAuthorizationRequest"("expiresAt");
CREATE TABLE "OAuthAuthorizationCode" (
  "codeId" TEXT PRIMARY KEY, "secretHash" TEXT NOT NULL, "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL, "resource" TEXT NOT NULL, "scope" TEXT NOT NULL, "codeChallenge" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  CONSTRAINT "OAuthAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OAuthAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OAuthAuthorizationCode_expiresAt_idx" ON "OAuthAuthorizationCode"("expiresAt");
CREATE TABLE "OAuthFamily" (
  "id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL, "scope" TEXT NOT NULL, "resource" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthFamily_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OAuthFamily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AuthUser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OAuthFamily_userId_idx" ON "OAuthFamily"("userId");
CREATE INDEX "OAuthFamily_expiresAt_idx" ON "OAuthFamily"("expiresAt");
CREATE TABLE "OAuthGrant" (
  "id" TEXT PRIMARY KEY, "familyId" TEXT NOT NULL, "refreshTokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3), "replacedById" TEXT,
  CONSTRAINT "OAuthGrant_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "OAuthFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OAuthGrant_familyId_idx" ON "OAuthGrant"("familyId");
CREATE INDEX "OAuthGrant_expiresAt_idx" ON "OAuthGrant"("expiresAt");
CREATE TABLE "AuthRateLimit" ("key" TEXT PRIMARY KEY, "hits" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");
COMMIT;
