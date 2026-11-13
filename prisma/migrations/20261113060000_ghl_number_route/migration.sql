-- A client's toll-free number can now go either way from the Office: a Hell-level
-- number (no ID check) or a number in their GHL sub-account after a person passes GHL's ID check.
ALTER TABLE "HlNumberRequest" ADD COLUMN "route" TEXT NOT NULL DEFAULT 'hl';

-- The browser worker's job for the GHL route (src/lib/ghl-number).
CREATE TABLE "GhlNumberJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pickedNumber" TEXT,
    "buyStartedAt" TIMESTAMP(3),
    "phoneNumber" TEXT,
    "forwardsTo" TEXT,
    "lastError" TEXT,
    "detail" TEXT,
    "log" JSONB,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlNumberJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GhlNumberJob_clientId_key" ON "GhlNumberJob"("clientId");
CREATE INDEX "GhlNumberJob_status_nextAttemptAt_idx" ON "GhlNumberJob"("status", "nextAttemptAt");
CREATE INDEX "GhlNumberJob_buyStartedAt_idx" ON "GhlNumberJob"("buyStartedAt");

ALTER TABLE "GhlNumberJob" ADD CONSTRAINT "GhlNumberJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GhlNumberJobShot" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GhlNumberJobShot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GhlNumberJobShot_jobId_createdAt_idx" ON "GhlNumberJobShot"("jobId", "createdAt");

ALTER TABLE "GhlNumberJobShot" ADD CONSTRAINT "GhlNumberJobShot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GhlNumberJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
