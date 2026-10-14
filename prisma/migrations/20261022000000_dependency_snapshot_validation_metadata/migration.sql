ALTER TABLE "DependencySnapshot"
  ADD COLUMN "archiveScanVersion" INTEGER,
  ADD COLUMN "archiveEntries" INTEGER,
  ADD COLUMN "unpackedBytes" BIGINT;
