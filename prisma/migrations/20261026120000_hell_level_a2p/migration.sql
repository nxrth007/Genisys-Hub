-- CreateTable
CREATE TABLE "HlA2p" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT 'low_volume',
    "details" JSONB NOT NULL DEFAULT '{}',
    "stage" TEXT NOT NULL DEFAULT 'draft',
    "customerProfileSid" TEXT,
    "trustProductSid" TEXT,
    "brandSid" TEXT,
    "brandStatus" TEXT,
    "identityStatus" TEXT,
    "messagingServiceSid" TEXT,
    "campaignSid" TEXT,
    "campaignStatus" TEXT,
    "note" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "nextAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "filedBy" TEXT,
    "filedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlA2p_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HlA2p_accountId_key" ON "HlA2p"("accountId");

-- AddForeignKey
ALTER TABLE "HlA2p" ADD CONSTRAINT "HlA2p_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
