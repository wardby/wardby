-- NATIVE_SANDBOX_MAX_CONCURRENT counts the active native gateway sessions on every sandbox start.
CREATE INDEX "NativeGatewaySession_status_idx" ON "NativeGatewaySession"("status");
