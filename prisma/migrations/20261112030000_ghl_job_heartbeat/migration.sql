-- Lets a restarted Hub reclaim a sub-account job whose browser
-- process died during a deploy. The holder writes this every few
-- seconds; a quiet row is no longer running.
ALTER TABLE "GhlSubaccountJob" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
