-- Designs (phase 2): each version's format, Markdown only on Markdown versions,
-- version warnings, design files deduplicated per document by content hash,
-- and PNG/PDF export jobs (kept for an hour).
ALTER TABLE "DocumentVersion" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'markdown';
ALTER TABLE "DocumentVersion" ALTER COLUMN "markdown" DROP NOT NULL;
ALTER TABLE "DocumentVersion" ADD COLUMN "warnings" JSONB;

CREATE TABLE "DocumentContent" (
    "documentId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentContent_pkey" PRIMARY KEY ("documentId","hash")
);

CREATE TABLE "DocumentFile" (
    "versionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("versionId","path")
);
CREATE INDEX "DocumentFile_documentId_hash_idx" ON "DocumentFile"("documentId", "hash");

CREATE TABLE "DocumentExport" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "board" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "requestedById" TEXT,
    "guestId" TEXT,
    "mime" TEXT,
    "data" BYTEA,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "DocumentExport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocumentExport_documentId_createdAt_idx" ON "DocumentExport"("documentId", "createdAt");
CREATE INDEX "DocumentExport_status_createdAt_idx" ON "DocumentExport"("status", "createdAt");
CREATE INDEX "DocumentExport_createdAt_idx" ON "DocumentExport"("createdAt");

ALTER TABLE "DocumentContent" ADD CONSTRAINT "DocumentContent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_documentId_hash_fkey" FOREIGN KEY ("documentId", "hash") REFERENCES "DocumentContent"("documentId", "hash") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DocumentExport" ADD CONSTRAINT "DocumentExport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
