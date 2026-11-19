-- Stripe dispute defense: disputes, hashed audit log, service ledger,
-- clickwrap acknowledgements, portal activity, early fraud warnings,
-- service notices, milestone confirmations, and delivery receipts.
-- Repeat-disputer counts live on the client.

ALTER TABLE "Client" ADD COLUMN "disputeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "lastDisputeAt" TIMESTAMP(3);

CREATE TABLE "StripeDispute" (
    "id" TEXT NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeCustomerId" TEXT,
    "stripeInvoiceId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "networkReasonCode" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "dueBy" TIMESTAMP(3),
    "chargedAt" TIMESTAMP(3),
    "livemode" BOOLEAN NOT NULL DEFAULT true,
    "cardBrand" TEXT,
    "stripeSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "intakeId" TEXT,
    "matchMethod" TEXT,
    "matchConfidence" TEXT NOT NULL DEFAULT 'none',
    "narrative" TEXT,
    "narrativeEditedAt" TIMESTAMP(3),
    "narrativeEditedBy" TEXT,
    "evidenceJson" JSONB,
    "compellingEvidence" JSONB,
    "evidenceSha256" TEXT,
    "packetPdf" BYTEA,
    "packetBytes" INTEGER,
    "packetSha256" TEXT,
    "packetBuiltAt" TIMESTAMP(3),
    "stripeFileId" TEXT,
    "defenseStatus" TEXT NOT NULL DEFAULT 'new',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "pausedBy" TEXT,
    "stagedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "autoSubmitAt" TIMESTAMP(3),
    "lastError" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripeDispute_stripeDisputeId_key" ON "StripeDispute"("stripeDisputeId");
CREATE INDEX "StripeDispute_status_dueBy_idx" ON "StripeDispute"("status", "dueBy");
CREATE INDEX "StripeDispute_clientId_idx" ON "StripeDispute"("clientId");
CREATE INDEX "StripeDispute_defenseStatus_autoSubmitAt_idx" ON "StripeDispute"("defenseStatus", "autoSubmitAt");
CREATE INDEX "StripeDispute_stripeChargeId_idx" ON "StripeDispute"("stripeChargeId");

ALTER TABLE "StripeDispute" ADD CONSTRAINT "StripeDispute_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StripeDisputeEvent" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "actor" TEXT,
    "payload" JSONB,
    "prevHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeDisputeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripeDisputeEvent_disputeId_seq_key" ON "StripeDisputeEvent"("disputeId", "seq");
CREATE INDEX "StripeDisputeEvent_disputeId_createdAt_idx" ON "StripeDisputeEvent"("disputeId", "createdAt");

ALTER TABLE "StripeDisputeEvent" ADD CONSTRAINT "StripeDisputeEvent_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "StripeDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ServiceLedgerEntry" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceLedgerEntry_source_sourceId_key" ON "ServiceLedgerEntry"("source", "sourceId");
CREATE INDEX "ServiceLedgerEntry_clientId_occurredAt_idx" ON "ServiceLedgerEntry"("clientId", "occurredAt");

ALTER TABLE "ServiceLedgerEntry" ADD CONSTRAINT "ServiceLedgerEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ServiceAcknowledgement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "intakeId" TEXT,
    "email" TEXT,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "source" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceAcknowledgement_clientId_kind_idx" ON "ServiceAcknowledgement"("clientId", "kind");
CREATE INDEX "ServiceAcknowledgement_email_idx" ON "ServiceAcknowledgement"("email");
CREATE INDEX "ServiceAcknowledgement_intakeId_idx" ON "ServiceAcknowledgement"("intakeId");

ALTER TABLE "ServiceAcknowledgement" ADD CONSTRAINT "ServiceAcknowledgement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PortalActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT,
    "email" TEXT,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortalActivity_clientId_createdAt_idx" ON "PortalActivity"("clientId", "createdAt");
CREATE INDEX "PortalActivity_email_createdAt_idx" ON "PortalActivity"("email", "createdAt");

ALTER TABLE "PortalActivity" ADD CONSTRAINT "PortalActivity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EarlyFraudWarning" (
    "id" TEXT NOT NULL,
    "stripeWarningId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "stripeCustomerId" TEXT,
    "actionable" BOOLEAN NOT NULL DEFAULT false,
    "fraudType" TEXT,
    "clientId" TEXT,
    "action" TEXT NOT NULL DEFAULT 'none',
    "actionDetail" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarlyFraudWarning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EarlyFraudWarning_stripeWarningId_key" ON "EarlyFraudWarning"("stripeWarningId");
CREATE INDEX "EarlyFraudWarning_clientId_idx" ON "EarlyFraudWarning"("clientId");

ALTER TABLE "EarlyFraudWarning" ADD CONSTRAINT "EarlyFraudWarning_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceNotice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "contentHash" TEXT NOT NULL,
    "snapshotSha256" TEXT,
    "snapshotPdf" BYTEA,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceNotice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceNotice_clientId_sentAt_idx" ON "ServiceNotice"("clientId", "sentAt");

ALTER TABLE "ServiceNotice" ADD CONSTRAINT "ServiceNotice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceMilestone" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceMilestone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ServiceMilestone_tokenHash_key" ON "ServiceMilestone"("tokenHash");
CREATE INDEX "ServiceMilestone_clientId_kind_idx" ON "ServiceMilestone"("clientId", "kind");

ALTER TABLE "ServiceMilestone" ADD CONSTRAINT "ServiceMilestone_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeliveryReceipt" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT,
    "tokenHash" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "lastOpenIp" TEXT,
    "lastOpenUa" TEXT,
    "bodyHash" TEXT NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryReceipt_tokenHash_key" ON "DeliveryReceipt"("tokenHash");
CREATE UNIQUE INDEX "DeliveryReceipt_channel_sourceId_key" ON "DeliveryReceipt"("channel", "sourceId");
CREATE INDEX "DeliveryReceipt_clientId_sentAt_idx" ON "DeliveryReceipt"("clientId", "sentAt");

ALTER TABLE "DeliveryReceipt" ADD CONSTRAINT "DeliveryReceipt_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
