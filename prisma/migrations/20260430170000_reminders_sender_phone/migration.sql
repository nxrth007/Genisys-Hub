-- E.164-formatted phone number to send SMS *from* (reminders + morning
-- briefs). Null = use the GHL sub-account's default location phone,
-- preserving prior behavior for any deployment that hasn't configured
-- this yet. Genisys's intent: a dedicated reminders number distinct
-- from Alex's main 603-605-8413, so customer-facing reminders don't
-- mingle with internal/agent traffic.
ALTER TABLE "RemindersConfig"
    ADD COLUMN IF NOT EXISTS "senderPhone" TEXT;
