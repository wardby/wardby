-- Document review states: a whole document's review lifecycle (draft, in_review,
-- changes_requested, approved, archived), its named reviewers and an append-only
-- history. Existing documents become drafts.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "reviewState" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Document" ADD COLUMN "reviewStateBeforeArchive" TEXT;
ALTER TABLE "Document" ADD COLUMN "finalApproverId" TEXT;

-- CreateTable
CREATE TABLE "DocumentReviewer" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "principalId" TEXT,
    "guestId" TEXT,
    "verdict" TEXT NOT NULL DEFAULT 'none',
    "versionNumber" INTEGER,
    "note" TEXT,
    "verdictAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentReviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentReviewEvent" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "actorPrincipalId" TEXT,
    "actorGuestId" TEXT,
    "kind" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "note" TEXT,
    "overridden" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentReviewEvent_pkey" PRIMARY KEY ("id")
);

-- A reviewer is a principal or a guest, never both or neither (not representable in schema.prisma).
ALTER TABLE "DocumentReviewer" ADD CONSTRAINT "DocumentReviewer_one_reviewer"
  CHECK (("principalId" IS NOT NULL) <> ("guestId" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "DocumentReviewer_documentId_principalId_key" ON "DocumentReviewer"("documentId", "principalId");
CREATE UNIQUE INDEX "DocumentReviewer_documentId_guestId_key" ON "DocumentReviewer"("documentId", "guestId");
CREATE INDEX "DocumentReviewer_documentId_idx" ON "DocumentReviewer"("documentId");
CREATE INDEX "DocumentReviewEvent_documentId_createdAt_idx" ON "DocumentReviewEvent"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentReviewer" ADD CONSTRAINT "DocumentReviewer_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentReviewer" ADD CONSTRAINT "DocumentReviewer_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "DocumentGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentReviewEvent" ADD CONSTRAINT "DocumentReviewEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
