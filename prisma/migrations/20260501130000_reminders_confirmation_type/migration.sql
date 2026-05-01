-- Booking-confirmation SMS — fires right after the appointment is
-- recorded, BEFORE the existing 1-day / 2-hr / 30-min / start
-- cascade. Off by default so flipping it on for the first time
-- doesn't blast a "Thanks for booking!" text retroactively to every
-- historical appointment; the corresponding code-side backfill
-- marks pre-existing rows 'skipped' on first enable.
ALTER TABLE "RemindersConfig"
    ADD COLUMN IF NOT EXISTS "confirmationEnabled" BOOLEAN NOT NULL DEFAULT false;
