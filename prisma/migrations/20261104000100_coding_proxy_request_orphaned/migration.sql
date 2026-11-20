-- orphanedAt marks a request settled because its owner's lease ran out (as opposed to a stream that
-- broke under a live proxy), which is the only kind of settled request a retry may take over.

ALTER TABLE "CodingProxyRequest" ADD COLUMN "orphanedAt" TIMESTAMP(3);
