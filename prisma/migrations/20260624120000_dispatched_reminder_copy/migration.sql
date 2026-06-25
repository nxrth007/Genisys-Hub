-- Refresh customer reminder copy for the "dispatched" gating change
-- (2026-06-24). The dispatcher resolves each message from the Global
-- ReminderTemplate row (clientId IS NULL) and only falls back to the
-- hardcoded DEFAULT_TEMPLATES when no row exists — so the live copy
-- has to be updated here, not just in code.
--
-- New sequence: a short confirmation FYI at booking + four same-day
-- reminders (4hr/2hr/30min/start) that arm only once an appointment is
-- marked "dispatched". The day-before ('1day') row is intentionally
-- left untouched — it's retired from the active sequence but kept so
-- any in-flight rows queued under the old flow still render.
--
-- UPDATE-only (no INSERT): ReminderTemplate.id is a client-generated
-- cuid, so a raw INSERT would violate the NOT NULL id. If a Global row
-- is somehow absent, the code-level DEFAULT_TEMPLATES fallback already
-- carries the same new copy, so an UPDATE that matches 0 rows is safe.
-- Per-client custom templates (clientId set) are left as-is.

UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, thanks for speaking with our representative. We''ll keep you updated about your appointment with an energy expert in your area.'
WHERE "clientId" IS NULL AND "reminderType" = 'confirmation';

UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, just a heads up — your appointment with {clientName} is scheduled for today at {apptTime}. An energy expert will be reaching out then to go over your solar options and potential savings. Talk soon.'
WHERE "clientId" IS NULL AND "reminderType" = '4hr';

UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, reminder that your appointment with {clientName} is coming up at {apptTime}. Your energy expert will be reaching out in a couple of hours to go over your solar options and answer any questions.'
WHERE "clientId" IS NULL AND "reminderType" = '2hr';

UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, your appointment with {clientName} starts in about 30 minutes. Please keep your phone nearby — your energy expert will be reaching out shortly.'
WHERE "clientId" IS NULL AND "reminderType" = '30min';

UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, your appointment with {clientName} is starting now. Your energy expert will be reaching out shortly.'
WHERE "clientId" IS NULL AND "reminderType" = 'start';
