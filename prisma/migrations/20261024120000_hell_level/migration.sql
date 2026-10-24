-- CreateTable
CREATE TABLE "HlAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlPhoneNumber" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "providerSid" TEXT,
    "kind" TEXT NOT NULL,
    "forwardTo" TEXT,
    "whisper" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "verificationStatus" TEXT NOT NULL DEFAULT 'none',
    "verificationSid" TEXT,
    "verificationNote" TEXT,
    "verificationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlContact" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT,
    "smsConsent" BOOLEAN NOT NULL DEFAULT false,
    "smsConsentAt" TIMESTAMP(3),
    "dnd" BOOLEAN NOT NULL DEFAULT false,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "lastMessageAt" TIMESTAMP(3),
    "lastMessage" TEXT,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "providerSid" TEXT,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "by" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlPipeline" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlOpportunity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "source" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlForm" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'form',
    "fields" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlFormSubmission" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "data" JSONB NOT NULL,
    "pageUrl" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HlFormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlWorkflow" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trigger" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "allowReentry" BOOLEAN NOT NULL DEFAULT true,
    "template" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlWorkflowRun" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "context" JSONB NOT NULL DEFAULT '{}',
    "log" JSONB NOT NULL DEFAULT '[]',
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HlAccount_clientId_key" ON "HlAccount"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "HlPhoneNumber_number_key" ON "HlPhoneNumber"("number");

-- CreateIndex
CREATE INDEX "HlPhoneNumber_accountId_idx" ON "HlPhoneNumber"("accountId");

-- CreateIndex
CREATE INDEX "HlContact_accountId_phone_idx" ON "HlContact"("accountId", "phone");

-- CreateIndex
CREATE INDEX "HlContact_accountId_email_idx" ON "HlContact"("accountId", "email");

-- CreateIndex
CREATE INDEX "HlContact_accountId_lastMessageAt_idx" ON "HlContact"("accountId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "HlContact_accountId_createdAt_idx" ON "HlContact"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HlMessage_providerSid_key" ON "HlMessage"("providerSid");

-- CreateIndex
CREATE INDEX "HlMessage_contactId_createdAt_idx" ON "HlMessage"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "HlMessage_accountId_createdAt_idx" ON "HlMessage"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "HlPipeline_accountId_idx" ON "HlPipeline"("accountId");

-- CreateIndex
CREATE INDEX "HlOpportunity_accountId_pipelineId_stageId_idx" ON "HlOpportunity"("accountId", "pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "HlOpportunity_contactId_idx" ON "HlOpportunity"("contactId");

-- CreateIndex
CREATE INDEX "HlForm_accountId_idx" ON "HlForm"("accountId");

-- CreateIndex
CREATE INDEX "HlFormSubmission_formId_createdAt_idx" ON "HlFormSubmission"("formId", "createdAt");

-- CreateIndex
CREATE INDEX "HlFormSubmission_accountId_createdAt_idx" ON "HlFormSubmission"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "HlWorkflow_accountId_status_idx" ON "HlWorkflow"("accountId", "status");

-- CreateIndex
CREATE INDEX "HlWorkflowRun_status_nextRunAt_idx" ON "HlWorkflowRun"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "HlWorkflowRun_workflowId_createdAt_idx" ON "HlWorkflowRun"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "HlWorkflowRun_contactId_idx" ON "HlWorkflowRun"("contactId");

-- AddForeignKey
ALTER TABLE "HlAccount" ADD CONSTRAINT "HlAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlPhoneNumber" ADD CONSTRAINT "HlPhoneNumber_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlContact" ADD CONSTRAINT "HlContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlMessage" ADD CONSTRAINT "HlMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlMessage" ADD CONSTRAINT "HlMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlPipeline" ADD CONSTRAINT "HlPipeline_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlOpportunity" ADD CONSTRAINT "HlOpportunity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlOpportunity" ADD CONSTRAINT "HlOpportunity_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "HlPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlOpportunity" ADD CONSTRAINT "HlOpportunity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlForm" ADD CONSTRAINT "HlForm_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlFormSubmission" ADD CONSTRAINT "HlFormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "HlForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlFormSubmission" ADD CONSTRAINT "HlFormSubmission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlFormSubmission" ADD CONSTRAINT "HlFormSubmission_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlWorkflow" ADD CONSTRAINT "HlWorkflow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlWorkflowRun" ADD CONSTRAINT "HlWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "HlWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlWorkflowRun" ADD CONSTRAINT "HlWorkflowRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlWorkflowRun" ADD CONSTRAINT "HlWorkflowRun_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

