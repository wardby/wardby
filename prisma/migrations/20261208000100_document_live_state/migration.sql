-- Live co-editing: each document's Yjs state, the state of each version (for merging publishes), the replica
-- that leads it, and share-link tickets for joining it.
CREATE TABLE "DocumentLiveState" (
    "documentId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentLiveState_pkey" PRIMARY KEY ("documentId")
);

CREATE TABLE "DocumentLiveVersionState" (
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLiveVersionState_pkey" PRIMARY KEY ("documentId","versionNumber")
);

CREATE TABLE "DocumentLiveLease" (
    "documentId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentLiveLease_pkey" PRIMARY KEY ("documentId")
);

CREATE TABLE "DocumentLiveTicket" (
    "tokenHash" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "readOnly" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentLiveTicket_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "DocumentLiveTicket_documentId_idx" ON "DocumentLiveTicket"("documentId");

ALTER TABLE "DocumentLiveState" ADD CONSTRAINT "DocumentLiveState_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentLiveVersionState" ADD CONSTRAINT "DocumentLiveVersionState_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentLiveLease" ADD CONSTRAINT "DocumentLiveLease_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentLiveTicket" ADD CONSTRAINT "DocumentLiveTicket_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
