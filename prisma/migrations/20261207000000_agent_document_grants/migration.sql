-- Agent grantees on documents (#625): read/comment for a native agent.
ALTER TABLE "ResourceGrant" ADD COLUMN "granteeAgentId" TEXT;

ALTER TABLE "ResourceGrant" ADD CONSTRAINT "ResourceGrant_granteeAgentId_fkey"
    FOREIGN KEY ("granteeAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ResourceGrant_granteeAgentId_idx" ON "ResourceGrant"("granteeAgentId");

ALTER TABLE "ResourceGrant" DROP CONSTRAINT "ResourceGrant_grantee_shape";
ALTER TABLE "ResourceGrant" ADD CONSTRAINT "ResourceGrant_grantee_shape" CHECK (
    ("granteeKind" = 'principal' AND "granteePrincipalId" IS NOT NULL AND "granteeAgentId" IS NULL
        AND "granteeKey" = 'principal:' || "granteePrincipalId")
    OR ("granteeKind" = 'everyone' AND "granteePrincipalId" IS NULL AND "granteeAgentId" IS NULL
        AND "granteeKey" = 'everyone')
    OR ("granteeKind" = 'agent' AND "granteeAgentId" IS NOT NULL AND "granteePrincipalId" IS NULL
        AND "resourceType" = 'document' AND "granteeKey" = 'agent:' || "granteeAgentId")
);
