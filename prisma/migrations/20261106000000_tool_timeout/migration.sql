-- A sandboxed tool may set its own time limit per call, in milliseconds. Null keeps the
-- default limit. A host provider's approved snapshot of a tool keeps the value it approved.
ALTER TABLE "Tool" ADD COLUMN "timeoutMs" INTEGER;
ALTER TABLE "HostProviderOperation" ADD COLUMN "timeoutMs" INTEGER;
