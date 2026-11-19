-- Additive: a claim row per dependency-cache upload in flight. It is the cross-replica "uploading" guard,
-- and lets the eviction pass reclaim the blob of an upload whose proxy died before it recorded a snapshot.
CREATE TABLE "DependencyUploadClaim" (
    "id" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "projectPath" TEXT NOT NULL DEFAULT '.',
    "lockHash" TEXT NOT NULL,
    "workerImage" TEXT NOT NULL,
    "blobKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DependencyUploadClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DependencyUploadClaim_blobKey_key" ON "DependencyUploadClaim"("blobKey");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyUploadClaim_ecosystem_repository_projectPath_lock_key" ON "DependencyUploadClaim"("ecosystem", "repository", "projectPath", "lockHash", "workerImage");

-- CreateIndex
CREATE UNIQUE INDEX "DependencyUploadClaim_runId_ecosystem_projectPath_key" ON "DependencyUploadClaim"("runId", "ecosystem", "projectPath");

-- CreateIndex
CREATE INDEX "DependencyUploadClaim_createdAt_idx" ON "DependencyUploadClaim"("createdAt");
