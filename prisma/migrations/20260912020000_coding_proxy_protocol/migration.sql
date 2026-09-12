BEGIN;

ALTER TABLE "CodingProxySession"
  ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'openai-responses';

ALTER TABLE "CodingProxySession"
  ADD CONSTRAINT "CodingProxySession_protocol_check"
  CHECK ("protocol" IN ('openai-responses', 'anthropic-messages'));

COMMIT;
