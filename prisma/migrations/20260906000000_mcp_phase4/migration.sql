-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: Phase 4 MCP server —
-- principals/ownership, task handles, secrets, webhooks, self-hosted OAuth.
-- Mirrors prisma/schema.prisma exactly.

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('run', 'tool_authoring');
CREATE TYPE "TaskStatus" AS ENUM ('working', 'input_required', 'completed', 'failed', 'cancelled');
CREATE TYPE "WebhookStatus" AS ENUM ('enabled', 'disabled');

-- CreateTable
CREATE TABLE "Principal" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Principal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Principal_subject_key" ON "Principal"("subject");

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "kind" "TaskKind" NOT NULL,
    "runId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'working',
    "inputRequests" JSONB,
    "inputResponses" JSONB,
    "result" JSONB,
    "error" JSONB,
    "ttlAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Secret_ownerId_name_key" ON "Secret"("ownerId", "name");

-- CreateTable
CREATE TABLE "AgentSecret" (
    "agentId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,

    CONSTRAINT "AgentSecret_pkey" PRIMARY KEY ("agentId","secretId")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'enabled',
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFiredAt" TIMESTAMP(3),

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Webhook_agentId_idx" ON "Webhook"("agentId");

-- CreateTable
CREATE TABLE "OAuthClient" (
    "clientId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "clientSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthGrant_refreshToken_key" ON "OAuthGrant"("refreshToken");

-- AlterTable: Agent gains ownerId
ALTER TABLE "Agent" ADD COLUMN "ownerId" TEXT;

-- AlterTable: Tool gains ownerId
ALTER TABLE "Tool" ADD COLUMN "ownerId" TEXT;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Principal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentSecret" ADD CONSTRAINT "AgentSecret_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentSecret" ADD CONSTRAINT "AgentSecret_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
