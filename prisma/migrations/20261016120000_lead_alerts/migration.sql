-- Lead texts for No EIN clients, sent from the Lead Genisys sub-account.
ALTER TABLE "ClientAlertsConfig" ADD COLUMN "leadAlertsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "LeadAlert" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "contactId" TEXT,
    "clientId" TEXT,
    "leadName" TEXT,
    "leadPhone" TEXT,
    "leadEmail" TEXT,
    "source" TEXT,
    "recipientPhone" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "messageId" TEXT,
    "errorMessage" TEXT,
    "payload" JSONB NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadAlert_dedupKey_key" ON "LeadAlert"("dedupKey");
CREATE INDEX "LeadAlert_clientId_createdAt_idx" ON "LeadAlert"("clientId", "createdAt");
CREATE INDEX "LeadAlert_locationId_contactId_createdAt_idx" ON "LeadAlert"("locationId", "contactId", "createdAt");
CREATE INDEX "LeadAlert_createdAt_idx" ON "LeadAlert"("createdAt");

ALTER TABLE "LeadAlert" ADD CONSTRAINT "LeadAlert_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
