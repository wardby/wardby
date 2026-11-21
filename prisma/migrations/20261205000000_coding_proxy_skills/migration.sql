-- A Claude Code proxy session whose run may use the Skill tool (native mode with repository skills, #582).
ALTER TABLE "CodingProxySession" ADD COLUMN "skills" BOOLEAN NOT NULL DEFAULT false;

-- The proxy's first refusal of a session's request (a fixed code), so a failed run can name it.
ALTER TABLE "CodingProxySession" ADD COLUMN "requestRefusal" TEXT;
