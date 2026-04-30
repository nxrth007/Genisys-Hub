-- AppointmentReminder, ReminderTemplate, and RemindersConfig — backing
-- tables for the SMS-reminder feature. One reminder row per (appointment,
-- type) gets queued by the scheduler; the dispatcher walks rows where
-- scheduledFor <= now() and status='pending' once per minute.

CREATE TABLE "AppointmentReminder" (
    "id"                TEXT NOT NULL,
    "appointmentId"     TEXT,
    "sheetTabTitle"     TEXT,
    "sheetRowNumber"    INTEGER,
    "sourceKey"         TEXT NOT NULL,
    "reminderType"      TEXT NOT NULL,
    "scheduledFor"      TIMESTAMP(3) NOT NULL,
    "customerName"      TEXT NOT NULL,
    "customerPhone"     TEXT NOT NULL,
    "customerTimezone"  TEXT NOT NULL,
    "apptDateTime"      TIMESTAMP(3) NOT NULL,
    "clientId"          TEXT,
    "clientName"        TEXT,
    "address"           TEXT,
    "agentName"         TEXT,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "sentAt"            TIMESTAMP(3),
    "errorMessage"      TEXT,
    "ghlContactId"      TEXT,
    "ghlMessageId"      TEXT,
    "ghlConversationId" TEXT,
    "messageBody"       TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_reminder_source_type"
    ON "AppointmentReminder"("sourceKey", "reminderType");

CREATE INDEX "AppointmentReminder_scheduledFor_status_idx"
    ON "AppointmentReminder"("scheduledFor", "status");

CREATE INDEX "AppointmentReminder_appointmentId_idx"
    ON "AppointmentReminder"("appointmentId");

CREATE INDEX "AppointmentReminder_clientId_idx"
    ON "AppointmentReminder"("clientId");

CREATE INDEX "AppointmentReminder_status_sentAt_idx"
    ON "AppointmentReminder"("status", "sentAt");

ALTER TABLE "AppointmentReminder"
    ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentReminder"
    ADD CONSTRAINT "AppointmentReminder_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-(client, reminderType) message body. clientId IS NULL = global
-- default override.
CREATE TABLE "ReminderTemplate" (
    "id"           TEXT NOT NULL,
    "clientId"     TEXT,
    "reminderType" TEXT NOT NULL,
    "body"         TEXT NOT NULL,
    "enabled"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_template_client_type"
    ON "ReminderTemplate"("clientId", "reminderType");

ALTER TABLE "ReminderTemplate"
    ADD CONSTRAINT "ReminderTemplate_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Singleton config row. Hardcoded id="singleton" so upserts are
-- straightforward without us having to remember the cuid.
CREATE TABLE "RemindersConfig" (
    "id"             TEXT NOT NULL DEFAULT 'singleton',
    "enabled"        BOOLEAN NOT NULL DEFAULT false,
    "vaultEntryName" TEXT NOT NULL DEFAULT 'GHL Genisys Token',
    "lookaheadDays"  INTEGER NOT NULL DEFAULT 10,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemindersConfig_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so the settings panel can always upsert
-- via update-by-id without first checking existence.
INSERT INTO "RemindersConfig" ("id", "enabled", "vaultEntryName", "lookaheadDays", "updatedAt")
VALUES ('singleton', false, 'GHL Genisys Token', 10, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
