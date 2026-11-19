-- Round 2 of dispute defense. Nullable columns and one new table.
-- Existing rows are not rewritten. Safe to apply on the production database.

ALTER TABLE "ServiceAcknowledgement" ADD COLUMN "textHash" TEXT;
ALTER TABLE "ServiceAcknowledgement" ADD COLUMN "textUrl" TEXT;

CREATE TABLE "CheckoutContext" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "intakeId" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutContext_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CheckoutContext_source_sourceId_key" ON "CheckoutContext"("source", "sourceId");
CREATE INDEX "CheckoutContext_clientId_occurredAt_idx" ON "CheckoutContext"("clientId", "occurredAt");

ALTER TABLE "CheckoutContext" ADD CONSTRAINT "CheckoutContext_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
