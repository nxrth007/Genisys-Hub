-- Payload Log: verbatim record of every authenticated NCT webhook hit.

CREATE TABLE "NctWebhookEvent" (
    "id" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "contentType" TEXT,
    "userAgent" TEXT,
    "outcome" TEXT NOT NULL,
    "leadId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NctWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NctWebhookEvent_createdAt_idx" ON "NctWebhookEvent"("createdAt");
