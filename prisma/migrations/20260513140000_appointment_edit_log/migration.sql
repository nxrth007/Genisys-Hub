-- AppointmentEditLog — audit trail of appointment edits.
-- Captured on PATCH /api/agent/appointments/[id] and PATCH
-- /api/call-center/master-tracker/[rowNumber]. Powers the new
-- "Appointment edits" tab under /agents so admin can see what Mary
-- (or anyone) changed on an existing appointment.

CREATE TABLE "AppointmentEditLog" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT,
    "sheetTabTitle" TEXT,
    "sheetRowNumber" INTEGER,
    "clientId" TEXT,
    "clientName" TEXT,
    "editorUserId" TEXT,
    "editorEmail" TEXT,
    "editorName" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "apptDateTime" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AppointmentEditLog_appointmentId_idx" ON "AppointmentEditLog"("appointmentId");
CREATE INDEX "AppointmentEditLog_editorUserId_idx" ON "AppointmentEditLog"("editorUserId");
CREATE INDEX "AppointmentEditLog_createdAt_idx" ON "AppointmentEditLog"("createdAt");
CREATE INDEX "AppointmentEditLog_clientId_idx" ON "AppointmentEditLog"("clientId");

ALTER TABLE "AppointmentEditLog"
    ADD CONSTRAINT "AppointmentEditLog_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentEditLog"
    ADD CONSTRAINT "AppointmentEditLog_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AppointmentEditLog"
    ADD CONSTRAINT "AppointmentEditLog_editorUserId_fkey"
    FOREIGN KEY ("editorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
