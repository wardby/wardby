-- Tool-backed host providers: config and approved snapshots. No secret values.
CREATE TABLE "HostProvider" (
    "name" TEXT NOT NULL,
    "contractVersion" INTEGER NOT NULL,
    "gitHost" TEXT NOT NULL,
    "apiHosts" TEXT[],
    "gitUsername" TEXT NOT NULL,
    "pullRequestUrlTemplate" TEXT NOT NULL,
    "repositoryApiPath" TEXT NOT NULL,
    "permissionApiPath" TEXT,
    "webhook" JSONB NOT NULL,
    "webhookSecretId" TEXT NOT NULL,
    "permissionSecretId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HostProvider_pkey" PRIMARY KEY ("name")
);

CREATE TABLE "HostProviderOperation" (
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "toolId" TEXT,
    "code" TEXT NOT NULL,
    "paramsZod" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostProviderOperation_pkey" PRIMARY KEY ("provider", "operation")
);

CREATE TABLE "HostProviderCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repositoryPattern" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "credentialKind" TEXT NOT NULL DEFAULT 'static',
    CONSTRAINT "HostProviderCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HostProviderTrustedAccount" (
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostProviderTrustedAccount_pkey" PRIMARY KEY ("provider", "accountId")
);

CREATE UNIQUE INDEX "HostProviderCredential_provider_repositoryPattern_key" ON "HostProviderCredential"("provider", "repositoryPattern");

ALTER TABLE "HostProvider" ADD CONSTRAINT "HostProvider_webhookSecretId_fkey" FOREIGN KEY ("webhookSecretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostProvider" ADD CONSTRAINT "HostProvider_permissionSecretId_fkey" FOREIGN KEY ("permissionSecretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostProviderOperation" ADD CONSTRAINT "HostProviderOperation_provider_fkey" FOREIGN KEY ("provider") REFERENCES "HostProvider"("name") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HostProviderOperation" ADD CONSTRAINT "HostProviderOperation_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HostProviderCredential" ADD CONSTRAINT "HostProviderCredential_provider_fkey" FOREIGN KEY ("provider") REFERENCES "HostProvider"("name") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HostProviderCredential" ADD CONSTRAINT "HostProviderCredential_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostProviderTrustedAccount" ADD CONSTRAINT "HostProviderTrustedAccount_provider_fkey" FOREIGN KEY ("provider") REFERENCES "HostProvider"("name") ON DELETE CASCADE ON UPDATE CASCADE;
