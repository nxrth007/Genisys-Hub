-- AlterTable
ALTER TABLE "HlAccount" ADD COLUMN     "ghlLocationId" TEXT;

-- AlterTable
ALTER TABLE "HlContact" ADD COLUMN     "ghlId" TEXT,
ADD COLUMN     "starred" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "HlPipeline" ADD COLUMN     "ghlId" TEXT;

-- AlterTable
ALTER TABLE "HlOpportunity" ADD COLUMN     "assignedTo" TEXT,
ADD COLUMN     "ghlId" TEXT;

-- AlterTable
ALTER TABLE "HlForm" ADD COLUMN     "ghlId" TEXT;

-- AlterTable
ALTER TABLE "HlFormSubmission" ADD COLUMN     "ghlId" TEXT;

-- AlterTable
ALTER TABLE "HlWorkflow" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "ghlId" TEXT,
ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "HlCalendar" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ghlId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlAppointment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "calendarId" TEXT,
    "contactId" TEXT,
    "ghlId" TEXT,
    "title" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "assignedTo" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlTask" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "ghlId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dueDate" TIMESTAMP(3),
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HlRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ghlId" TEXT,
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HlCalendar_accountId_idx" ON "HlCalendar"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "HlCalendar_accountId_ghlId_key" ON "HlCalendar"("accountId", "ghlId");

-- CreateIndex
CREATE INDEX "HlAppointment_accountId_startTime_idx" ON "HlAppointment"("accountId", "startTime");

-- CreateIndex
CREATE INDEX "HlAppointment_contactId_idx" ON "HlAppointment"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "HlAppointment_accountId_ghlId_key" ON "HlAppointment"("accountId", "ghlId");

-- CreateIndex
CREATE INDEX "HlTask_accountId_completed_dueDate_idx" ON "HlTask"("accountId", "completed", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "HlTask_accountId_ghlId_key" ON "HlTask"("accountId", "ghlId");

-- CreateIndex
CREATE INDEX "HlRecord_accountId_kind_idx" ON "HlRecord"("accountId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "HlRecord_accountId_kind_ghlId_key" ON "HlRecord"("accountId", "kind", "ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlAccount_ghlLocationId_key" ON "HlAccount"("ghlLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "HlContact_accountId_ghlId_key" ON "HlContact"("accountId", "ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlPipeline_accountId_ghlId_key" ON "HlPipeline"("accountId", "ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlOpportunity_accountId_ghlId_key" ON "HlOpportunity"("accountId", "ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlForm_accountId_ghlId_key" ON "HlForm"("accountId", "ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlFormSubmission_ghlId_key" ON "HlFormSubmission"("ghlId");

-- CreateIndex
CREATE UNIQUE INDEX "HlWorkflow_accountId_ghlId_key" ON "HlWorkflow"("accountId", "ghlId");

-- AddForeignKey
ALTER TABLE "HlCalendar" ADD CONSTRAINT "HlCalendar_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlAppointment" ADD CONSTRAINT "HlAppointment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlAppointment" ADD CONSTRAINT "HlAppointment_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "HlCalendar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlAppointment" ADD CONSTRAINT "HlAppointment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlTask" ADD CONSTRAINT "HlTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlTask" ADD CONSTRAINT "HlTask_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "HlContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HlRecord" ADD CONSTRAINT "HlRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "HlAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

