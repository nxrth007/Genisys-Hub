-- Browser jobs that put a client's Automation Copy into the GHL Incoming
-- Lead workflows with Workflow AI, checking each changed step before saving.
CREATE TABLE "GhlCustomizeJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "siteUrl" TEXT,
    "inputs" JSONB,
    "progress" JSONB,
    "lastError" TEXT,
    "detail" TEXT,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'site',
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlCustomizeJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GhlCustomizeJob_clientId_key" ON "GhlCustomizeJob"("clientId");
CREATE INDEX "GhlCustomizeJob_status_nextAttemptAt_idx" ON "GhlCustomizeJob"("status", "nextAttemptAt");

ALTER TABLE "GhlCustomizeJob" ADD CONSTRAINT "GhlCustomizeJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Page images from customize runs; the worker keeps the latest few per job.
CREATE TABLE "GhlCustomizeJobShot" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GhlCustomizeJobShot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GhlCustomizeJobShot_jobId_createdAt_idx" ON "GhlCustomizeJobShot"("jobId", "createdAt");

ALTER TABLE "GhlCustomizeJobShot" ADD CONSTRAINT "GhlCustomizeJobShot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GhlCustomizeJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
