-- NCT Media roofing-lead billing: webhook intake, per-lead Stripe charges,
-- and the Stripe -> Mercury sweep.

CREATE TABLE "NctBillingConfig" (
    "id" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "pricePerLeadCents" INTEGER NOT NULL DEFAULT 15000,
    "costPerLeadCents" INTEGER NOT NULL DEFAULT 11000,
    "weeklyCapCents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NctBillingConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NctBillingConfig_sourceKey_key" ON "NctBillingConfig"("sourceKey");
CREATE INDEX "NctBillingConfig_active_idx" ON "NctBillingConfig"("active");

CREATE TABLE "NctLead" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "service" TEXT,
    "rawPayload" JSONB,
    "configId" TEXT,
    "clientName" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "chargeStatus" TEXT NOT NULL DEFAULT 'failed',
    "stripePaymentIntentId" TEXT,
    "stripeChargeId" TEXT,
    "failureReason" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chargedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NctLead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NctLead_leadId_key" ON "NctLead"("leadId");
CREATE INDEX "NctLead_receivedAt_idx" ON "NctLead"("receivedAt");
CREATE INDEX "NctLead_configId_chargedAt_idx" ON "NctLead"("configId", "chargedAt");
CREATE INDEX "NctLead_chargeStatus_idx" ON "NctLead"("chargeStatus");

ALTER TABLE "NctLead" ADD CONSTRAINT "NctLead_configId_fkey"
    FOREIGN KEY ("configId") REFERENCES "NctBillingConfig"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "NctBillingSettings" (
    "id" TEXT NOT NULL,
    "webhookToken" TEXT NOT NULL,
    "chargingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sweepEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sweepMethod" TEXT NOT NULL DEFAULT 'standard',
    "sweepDestinationId" TEXT,
    "sweepFloorCents" INTEGER NOT NULL DEFAULT 0,
    "sweepMinCents" INTEGER NOT NULL DEFAULT 5000,
    "alertChannel" TEXT,
    "lastSweepAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NctBillingSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NctSweep" (
    "id" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "method" TEXT NOT NULL,
    "stripePayoutId" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NctSweep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NctSweep_createdAt_idx" ON "NctSweep"("createdAt");
