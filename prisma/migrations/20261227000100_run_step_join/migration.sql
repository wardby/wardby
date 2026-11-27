-- Join (people joined to a running coding run): who sent a join step, and when the worker received a message.
ALTER TABLE "RunStep" ADD COLUMN "fromPrincipalId" TEXT;
ALTER TABLE "RunStep" ADD COLUMN "deliveredAt" TIMESTAMP(3);
