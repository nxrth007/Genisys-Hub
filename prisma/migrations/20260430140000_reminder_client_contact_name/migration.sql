-- Add a separate snapshot for the client's contact-person name on
-- AppointmentReminder so SMS templates can distinguish between the
-- business name (clientName, e.g. "Brighton Capital Solar") and the
-- human contact (clientContactName, e.g. "David Mehta"). Existing
-- rows stay NULL — the next sheet sync repopulates them; in-flight
-- reminders just render the variable as an empty string.
ALTER TABLE "AppointmentReminder"
    ADD COLUMN IF NOT EXISTS "clientContactName" TEXT;
