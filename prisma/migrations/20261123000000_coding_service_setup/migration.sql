-- Setup jobs (#589): one-off containers a run executes after its services are ready and before its
-- agent starts. Nullable, so existing sidecar and toolchain rows are unchanged.
ALTER TABLE "CodingService" ADD COLUMN "command" JSONB, ADD COLUMN "waitFor" JSONB, ADD COLUMN "timeoutSeconds" INTEGER;
