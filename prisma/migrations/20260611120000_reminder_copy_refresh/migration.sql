-- Reminder copy refresh (Alex-approved plan, 2026-06-11).
--
-- Strategy: ONE hard Y/N ask at day-before, soft check at 4hr,
-- logistics-only everywhere else. "Reply STOP" on the confirmation
-- (first touch) only so later messages stay at 1 SMS segment.
--
-- The Global rows (clientId IS NULL) override the hardcoded
-- DEFAULT_TEMPLATES in lib/reminders-constants.ts, so updating the
-- code alone wouldn't change what confirmation + day-before send —
-- Alex authored Global rows for those via Settings. This migration
-- updates existing Global rows in place and inserts the missing
-- ones, so all 6 types resolve to the new copy after deploy. The
-- bodies here are byte-identical to DEFAULT_TEMPLATES.
--
-- NOTE: the ux_template_client_type unique index treats NULL
-- clientId as distinct (standard PG semantics), so ON CONFLICT
-- can't be used for the global rows — hence UPDATE + INSERT WHERE
-- NOT EXISTS per type.
--
-- Per-client overrides (clientId IS NOT NULL) are intentionally
-- untouched.

-- confirmation -------------------------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, thanks for speaking with our representative — your appointment with {clientName} is set for {apptDateTime}. We''ll text you reminders as it gets close. Reply STOP to opt out.',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = 'confirmation';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_confirmation', NULL, 'confirmation',
       'Hi {customerName}, thanks for speaking with our representative — your appointment with {clientName} is set for {apptDateTime}. We''ll text you reminders as it gets close. Reply STOP to opt out.',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = 'confirmation'
);

-- 1day (THE Y/N confirm point) ----------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, reminder: your {clientName} appointment is tomorrow at {apptTime}. Will you be able to make it? Reply Y to confirm or N to reschedule.',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = '1day';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_1day', NULL, '1day',
       'Hi {customerName}, reminder: your {clientName} appointment is tomorrow at {apptTime}. Will you be able to make it? Reply Y to confirm or N to reschedule.',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = '1day'
);

-- 4hr (soft check, no hard Y/N) ----------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, we''re all set for today at {apptTime} with {clientName}. If anything has changed, just reply here and we''ll help you reschedule.',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = '4hr';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_4hr', NULL, '4hr',
       'Hi {customerName}, we''re all set for today at {apptTime} with {clientName}. If anything has changed, just reply here and we''ll help you reschedule.',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = '4hr'
);

-- 2hr ------------------------------------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, quick heads up — your {clientName} appointment is in 2 hours at {apptTime}.',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = '2hr';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_2hr', NULL, '2hr',
       'Hi {customerName}, quick heads up — your {clientName} appointment is in 2 hours at {apptTime}.',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = '2hr'
);

-- 30min ----------------------------------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, your {clientName} appointment starts in 30 minutes. Please be available — talk soon!',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = '30min';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_30min', NULL, '30min',
       'Hi {customerName}, your {clientName} appointment starts in 30 minutes. Please be available — talk soon!',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = '30min'
);

-- start ----------------------------------------------------------------------
UPDATE "ReminderTemplate"
SET "body" = 'Hi {customerName}, it''s time! A {clientName} representative will reach out now.',
    "enabled" = true,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "clientId" IS NULL AND "reminderType" = 'start';

INSERT INTO "ReminderTemplate" ("id", "clientId", "reminderType", "body", "enabled", "createdAt", "updatedAt")
SELECT 'rt_global_start', NULL, 'start',
       'Hi {customerName}, it''s time! A {clientName} representative will reach out now.',
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ReminderTemplate" WHERE "clientId" IS NULL AND "reminderType" = 'start'
);
