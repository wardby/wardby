-- A Gemini coding run's server-side web tools (googleSearch / urlContext), fixed at session creation,
-- and the gemini-generate-content protocol those sessions use.
ALTER TABLE "CodingProxySession" ADD COLUMN "webTools" TEXT NOT NULL DEFAULT 'off';

ALTER TABLE "CodingProxySession" DROP CONSTRAINT "CodingProxySession_protocol_check";
ALTER TABLE "CodingProxySession"
  ADD CONSTRAINT "CodingProxySession_protocol_check"
  CHECK ("protocol" IN ('openai-responses', 'anthropic-messages', 'gemini-generate-content'));
