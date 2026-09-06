-- Cross-instance persistence for the out-of-band secret-entry flow. Replaces
-- the in-process `outcomes` Map in mcp/tools/secret-elicitation.ts, which
-- stranded a browser-form submission on the wrong instance under a
-- multi-instance HTTP deployment. New table only -- no existing table
-- touched.
CREATE TABLE "SecretElicitationOutcome" (
    "ownerId" TEXT NOT NULL,
    "secretName" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretElicitationOutcome_pkey" PRIMARY KEY ("ownerId","secretName")
);
