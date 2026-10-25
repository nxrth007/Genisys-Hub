-- CreateTable
CREATE TABLE "HlMember" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "staffId" TEXT,
    "invitedBy" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HlMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HlMember_userId_idx" ON "HlMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HlMember_accountId_userId_key" ON "HlMember"("accountId", "userId");

-- AddForeignKey
ALTER TABLE "HlMember" ADD CONSTRAINT "HlMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlMember" ADD CONSTRAINT "HlMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

