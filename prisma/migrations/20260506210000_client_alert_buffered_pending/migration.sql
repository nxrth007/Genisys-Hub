-- Buffer window for client alerts (per Alex's spec: 20-min window
-- between an agent saving an appointment and the SMS firing, so
-- typo-fixes / re-edits land before the client gets pinged).
--
-- Adds a new 'pending' status alongside the existing delivered /
-- backfilled / failed statuses. Pending rows are written by the
-- DB-driven path (POST /api/agent/appointments) with a scheduledFor
-- timestamp; the dispatcher (every-minute cron tick) finds them once
-- their window passes, sends the SMS, and flips status to 'delivered'.
-- Subsequent agent edits roll scheduledFor forward, effectively
-- rebasing the buffer.

ALTER TABLE "ClientAlertDelivery"
  ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);

-- Composite index so the dispatcher's
-- WHERE status='pending' AND scheduledFor <= now()
-- query stays fast as the table grows.
CREATE INDEX IF NOT EXISTS "ClientAlertDelivery_pending_due_idx"
  ON "ClientAlertDelivery" ("status", "scheduledFor");
