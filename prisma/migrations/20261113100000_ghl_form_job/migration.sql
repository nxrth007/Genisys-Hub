-- Making the snapshot's site form a client's own (src/lib/ghl-form).
CREATE TABLE "GhlFormJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'snapshot',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "formId" TEXT,
    "detail" TEXT,
    "lastError" TEXT,
    "log" JSONB,
    "shot" BYTEA,
    "shotStep" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlFormJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GhlFormJob_clientId_key" ON "GhlFormJob"("clientId");

CREATE INDEX "GhlFormJob_status_nextAttemptAt_idx" ON "GhlFormJob"("status", "nextAttemptAt");

ALTER TABLE "GhlFormJob" ADD CONSTRAINT "GhlFormJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
