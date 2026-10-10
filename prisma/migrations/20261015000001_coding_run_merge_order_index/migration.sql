-- Additive: find the few coding runs that carry a merge order without scanning the table.
CREATE INDEX "CodingRun_mergeOrder_idx" ON "CodingRun"("mergeOrder");
