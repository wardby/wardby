-- Substrate job launcher: launch fence, run phase and the tool relay (JOB_LAUNCHER=substrate).
CREATE TABLE "SubstrateRun" (
    "runId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "toolSeq" INTEGER NOT NULL DEFAULT 0,
    "nextChannel" INTEGER NOT NULL DEFAULT 1,
    "relayBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubstrateRun_pkey" PRIMARY KEY ("runId")
);

CREATE UNIQUE INDEX "SubstrateRun_token_key" ON "SubstrateRun"("token");

ALTER TABLE "SubstrateRun" ADD CONSTRAINT "SubstrateRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CodingRun"("runId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SubstrateRelayChannel" (
    "runToken" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "agentSeen" INTEGER NOT NULL DEFAULT 0,
    "toolSeen" INTEGER NOT NULL DEFAULT 0,
    "agentSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubstrateRelayChannel_pkey" PRIMARY KEY ("runToken", "channel")
);

ALTER TABLE "SubstrateRelayChannel" ADD CONSTRAINT "SubstrateRelayChannel_runToken_fkey" FOREIGN KEY ("runToken") REFERENCES "SubstrateRun"("token") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SubstrateRelayEvent" (
    "runToken" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT,
    "line" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubstrateRelayEvent_pkey" PRIMARY KEY ("runToken", "queue", "seq")
);

ALTER TABLE "SubstrateRelayEvent" ADD CONSTRAINT "SubstrateRelayEvent_runToken_fkey" FOREIGN KEY ("runToken") REFERENCES "SubstrateRun"("token") ON DELETE CASCADE ON UPDATE CASCADE;
