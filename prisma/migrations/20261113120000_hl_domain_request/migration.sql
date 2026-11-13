-- Forge's domain question in the Office (src/lib/hl/domain-request.ts).
CREATE TABLE "HlDomainRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_approval',
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "name" TEXT,
    "domainId" TEXT,
    "costCents" INTEGER,
    "detail" TEXT,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'onboarding',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlDomainRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HlDomainRequest_clientId_key" ON "HlDomainRequest"("clientId");

CREATE INDEX "HlDomainRequest_status_idx" ON "HlDomainRequest"("status");

ALTER TABLE "HlDomainRequest" ADD CONSTRAINT "HlDomainRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
