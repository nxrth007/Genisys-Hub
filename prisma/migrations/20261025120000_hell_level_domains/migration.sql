
-- CreateTable
CREATE TABLE "HlDomain" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "transferStatus" TEXT,
    "orderId" TEXT,
    "costCents" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "autoRenew" BOOLEAN,
    "lastError" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "log" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HlDomain_name_key" ON "HlDomain"("name");

-- CreateIndex
CREATE INDEX "HlDomain_accountId_idx" ON "HlDomain"("accountId");

-- CreateIndex
CREATE INDEX "HlDomain_status_idx" ON "HlDomain"("status");

-- AddForeignKey
ALTER TABLE "HlDomain" ADD CONSTRAINT "HlDomain_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

