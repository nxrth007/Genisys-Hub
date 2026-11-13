-- Forge's website build in the Office (src/lib/hl/site-request.ts).
CREATE TABLE "HlSiteRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_approval',
    "templateId" TEXT,
    "workspaceId" TEXT,
    "projectId" TEXT,
    "projectName" TEXT,
    "editorUrl" TEXT,
    "previewUrl" TEXT,
    "messageId" TEXT,
    "threadId" TEXT,
    "prompt" TEXT,
    "fill" JSONB,
    "detail" TEXT,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'onboarding',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "stepAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlSiteRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HlSiteRequest_clientId_key" ON "HlSiteRequest"("clientId");

CREATE INDEX "HlSiteRequest_status_idx" ON "HlSiteRequest"("status");

ALTER TABLE "HlSiteRequest" ADD CONSTRAINT "HlSiteRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
