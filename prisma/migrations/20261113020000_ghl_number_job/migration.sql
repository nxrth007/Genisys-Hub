-- Browser jobs that give a client's GHL sub-account its toll-free number:
-- bought in the number-bank sub-account, then moved with GHL's Move Numbers.
CREATE TABLE "GhlNumberJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pickedNumber" TEXT,
    "buyStartedAt" TIMESTAMP(3),
    "phoneNumber" TEXT,
    "movedAt" TIMESTAMP(3),
    "forwardsTo" TEXT,
    "lastError" TEXT,
    "detail" TEXT,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'subaccount',
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlNumberJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GhlNumberJob_clientId_key" ON "GhlNumberJob"("clientId");
CREATE INDEX "GhlNumberJob_status_nextAttemptAt_idx" ON "GhlNumberJob"("status", "nextAttemptAt");
CREATE INDEX "GhlNumberJob_buyStartedAt_idx" ON "GhlNumberJob"("buyStartedAt");

ALTER TABLE "GhlNumberJob" ADD CONSTRAINT "GhlNumberJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Page images from number runs; the worker keeps the latest few per job.
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
