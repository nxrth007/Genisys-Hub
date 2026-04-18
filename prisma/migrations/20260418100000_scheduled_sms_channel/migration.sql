-- Scheduled briefs: delivery channel + SMS-specific fields
ALTER TABLE "ScheduledSms" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'slack';
ALTER TABLE "ScheduledSms" ADD COLUMN "recipientPhone" TEXT;
ALTER TABLE "ScheduledSms" ADD COLUMN "notionAssignee" TEXT;
