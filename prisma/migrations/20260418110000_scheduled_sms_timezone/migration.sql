-- Per-schedule timezone override (so briefs can fire at the recipient's
-- local time rather than the schedule owner's).
ALTER TABLE "ScheduledSms" ADD COLUMN "timezone" TEXT;
