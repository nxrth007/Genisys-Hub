-- Queued browser jobs that create a GHL sub-account through the agency
-- dashboard (the locations API is refused on Agency Unlimited).
CREATE TABLE "GhlSubaccountJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "intakeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "detail" TEXT,
    "locationId" TEXT,
    "payload" JSONB NOT NULL,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'intake',
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlSubaccountJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GhlSubaccountJob_clientId_key" ON "GhlSubaccountJob"("clientId");
CREATE INDEX "GhlSubaccountJob_status_nextAttemptAt_idx" ON "GhlSubaccountJob"("status", "nextAttemptAt");

ALTER TABLE "GhlSubaccountJob" ADD CONSTRAINT "GhlSubaccountJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
