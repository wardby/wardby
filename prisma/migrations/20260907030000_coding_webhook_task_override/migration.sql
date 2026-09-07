-- Webhook task input is disabled by default and must be explicitly enabled
-- on the coding profile that owns the repository policy.
ALTER TABLE "CodingAgentProfile"
ADD COLUMN "allowWebhookTaskOverride" BOOLEAN NOT NULL DEFAULT false;
