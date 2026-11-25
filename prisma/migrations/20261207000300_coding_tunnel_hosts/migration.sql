-- Per-agent CONNECT tunnel hosts (#627): the agent's patterns and who approved `*`.
ALTER TABLE "CodingAgentProfile" ADD COLUMN "tunnelHosts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CodingAgentProfile" ADD COLUMN "tunnelAnyHostAuthorizedById" TEXT;
ALTER TABLE "CodingAgentProfile" ADD COLUMN "tunnelAnyHostAuthorizedAt" TIMESTAMP(3);

-- The patterns a run was given at dispatch, pinned on its proxy session.
ALTER TABLE "CodingProxySession" ADD COLUMN "tunnelHosts" TEXT[] DEFAULT ARRAY[]::TEXT[];
