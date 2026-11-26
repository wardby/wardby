-- The newest version merged into (or saved from) each live state; later versions are merged in on load.
ALTER TABLE "DocumentLiveState" ADD COLUMN "versionNumber" INTEGER NOT NULL DEFAULT 0;
