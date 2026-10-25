-- AlterTable
ALTER TABLE "HlContact" ADD COLUMN     "emailDnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailDndReason" TEXT;

-- CreateTable
CREATE TABLE "HlEmailDomain" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "rootDomain" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "fromName" TEXT,
    "fromLocal" TEXT NOT NULL DEFAULT 'hello',
    "forwardReplies" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'verifying',
    "dnsMode" TEXT NOT NULL,
    "records" JSONB NOT NULL DEFAULT '[]',
    "routeId" TEXT,
    "lastError" TEXT,
    "checkedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlEmailDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HlEmailDomain_accountId_key" ON "HlEmailDomain"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "HlEmailDomain_domain_key" ON "HlEmailDomain"("domain");

-- AddForeignKey
ALTER TABLE "HlEmailDomain" ADD CONSTRAINT "HlEmailDomain_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

