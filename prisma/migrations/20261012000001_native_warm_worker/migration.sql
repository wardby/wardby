-- Additive: the native sandbox warm pool. One row per pool worker, inserted
-- before the worker exists; a run claims an idle row with a conditional update.

-- CreateEnum
CREATE TYPE "NativeWarmWorkerStatus" AS ENUM ('warming', 'idle', 'claimed', 'retiring');

-- CreateTable
CREATE TABLE "NativeWarmWorker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "NativeWarmWorkerStatus" NOT NULL DEFAULT 'warming',
    "specHash" TEXT NOT NULL,
    "runId" TEXT,
    "readyAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeWarmWorker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NativeWarmWorker_name_key" ON "NativeWarmWorker"("name");

-- CreateIndex
CREATE UNIQUE INDEX "NativeWarmWorker_runId_key" ON "NativeWarmWorker"("runId");

-- CreateIndex
CREATE INDEX "NativeWarmWorker_status_specHash_idx" ON "NativeWarmWorker"("status", "specHash");

-- AddForeignKey
ALTER TABLE "NativeWarmWorker" ADD CONSTRAINT "NativeWarmWorker_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
