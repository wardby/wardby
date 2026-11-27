-- Claude Code agents that existed before sub-agents keep today's behaviour (no Agent tool): their
-- profiles get subAgents false. New profiles still default to true (20261208000400). Data only; no
-- schema change.
BEGIN;

SET LOCAL lock_timeout = '5s';

UPDATE "CodingAgentProfile" SET "subAgents" = false WHERE "provider" = 'claude-code';

COMMIT;
