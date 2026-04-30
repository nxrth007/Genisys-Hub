-- Add quiet-hours columns to RemindersConfig. Defaults align with the
-- TCPA-allowed window (don't send SMS before 8 AM or after 9 PM in
-- the customer's local time). Reminders that would fire outside the
-- window stay status='pending' and get retried on subsequent ticks
-- once the window opens.

ALTER TABLE "RemindersConfig"
    ADD COLUMN IF NOT EXISTS "quietHoursStart" TEXT NOT NULL DEFAULT '21:00',
    ADD COLUMN IF NOT EXISTS "quietHoursEnd"   TEXT NOT NULL DEFAULT '08:00';
