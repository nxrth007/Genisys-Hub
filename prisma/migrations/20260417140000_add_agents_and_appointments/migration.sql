-- User: credentials-auth + agent-approval fields
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "agentSheetTab" TEXT;
ALTER TABLE "User" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "approvedById" TEXT;

-- Appointment table
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "apptDateTime" TIMESTAMP(3) NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "address" TEXT,
    "email" TEXT,
    "monthlyBill" TEXT,
    "utilityProvider" TEXT,
    "roofType" TEXT,
    "roofAge" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "notes" TEXT,
    "callRecordingLink" TEXT,
    "agentSheetRowNumber" INTEGER,
    "masterSheetRowNumber" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "Appointment_agentUserId_createdAt_idx" ON "Appointment"("agentUserId", "createdAt");
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");
CREATE INDEX "Appointment_apptDateTime_idx" ON "Appointment"("apptDateTime");

-- Foreign key to User with cascade on agent deletion
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_agentUserId_fkey"
  FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
