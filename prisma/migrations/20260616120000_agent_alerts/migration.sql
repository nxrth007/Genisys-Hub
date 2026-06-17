-- Agent alerts — feedback loop to the booking agent when a customer
-- declines/reschedules a reminder or a client marks an appointment
-- no-show / cancelled. Surfaces in the /agent portal.

CREATE TABLE "AgentAlert" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "appointmentId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "clientName" TEXT,
    "apptDateTime" TIMESTAMP(3),
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentAlert_dedupKey_key" ON "AgentAlert"("dedupKey");
CREATE INDEX "AgentAlert_agentUserId_status_createdAt_idx" ON "AgentAlert"("agentUserId", "status", "createdAt");
CREATE INDEX "AgentAlert_appointmentId_idx" ON "AgentAlert"("appointmentId");

ALTER TABLE "AgentAlert"
    ADD CONSTRAINT "AgentAlert_agentUserId_fkey"
    FOREIGN KEY ("agentUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
