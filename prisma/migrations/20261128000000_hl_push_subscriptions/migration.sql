-- Genisys OS notifications (Web Push): one new table, one row per phone or browser that turned them on.
-- Nothing existing changes. Safe to apply on the production database.

-- CreateTable
CREATE TABLE "HlPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userAgent" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HlPushSubscription_endpoint_key" ON "HlPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "HlPushSubscription_userId_idx" ON "HlPushSubscription"("userId");

-- AddForeignKey
ALTER TABLE "HlPushSubscription" ADD CONSTRAINT "HlPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
