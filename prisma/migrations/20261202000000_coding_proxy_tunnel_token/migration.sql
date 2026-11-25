-- AlterTable
ALTER TABLE "CodingProxySession" ADD COLUMN     "tunnelTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CodingProxySession_tunnelTokenHash_key" ON "CodingProxySession"("tunnelTokenHash");
