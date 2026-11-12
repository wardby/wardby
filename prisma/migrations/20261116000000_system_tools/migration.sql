-- System tools (#529): who published a tool, and connection grants for public tools.
ALTER TABLE "Tool" ADD COLUMN "publishedById" TEXT,
ADD COLUMN "publishedAt" TIMESTAMP(3);

CREATE TABLE "ToolConnectionGrant" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "channels" TEXT[],
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolConnectionGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolConnectionGrant_toolId_connection_key" ON "ToolConnectionGrant"("toolId", "connection");

ALTER TABLE "ToolConnectionGrant" ADD CONSTRAINT "ToolConnectionGrant_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
