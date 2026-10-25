-- CreateTable
CREATE TABLE "HlMedia" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "sourceUrl" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HlMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HlMedia_accountId_createdAt_idx" ON "HlMedia"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "HlMedia" ADD CONSTRAINT "HlMedia_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

