-- doc_create counts the documents a run has created by DocumentVersion.runId (#625).
CREATE INDEX "DocumentVersion_runId_idx" ON "DocumentVersion"("runId");
