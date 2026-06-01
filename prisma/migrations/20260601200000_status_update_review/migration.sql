-- Phase 1 of the /call-center/status-updates triage page.
--
-- Adds two columns to Appointment so admins can mark a
-- client-reported status update as "seen / handled":
--
--   clientStatusReviewedAt    — when the review happened. Null =
--                                unreviewed. Drives the red-dot
--                                badge in the Call Center tabs nav
--                                and the "Awaiting client review"
--                                bucket on the page.
--   clientStatusReviewedById  — Hub user who clicked the toggle.
--                                Lets the UI show "Reviewed by
--                                Ethan" without re-querying.
--
-- Both columns default to NULL on existing rows — every client
-- update made before this migration starts out as "unreviewed",
-- which is the correct starting state for triage.

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "clientStatusReviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "clientStatusReviewedById" TEXT;

-- FK to User. SetNull on delete so blowing away a user account
-- (rare, but possible) doesn't cascade-delete appointment rows —
-- the appointment's review history simply detaches.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Appointment_clientStatusReviewedById_fkey'
  ) THEN
    ALTER TABLE "Appointment"
      ADD CONSTRAINT "Appointment_clientStatusReviewedById_fkey"
      FOREIGN KEY ("clientStatusReviewedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

-- Partial index on the unreviewed rows. The status-updates page +
-- the badge-count endpoint both filter by
-- "clientStatusUpdatedAt IS NOT NULL AND clientStatusReviewedAt IS NULL",
-- and once steady-state most rows will be reviewed — a partial
-- index keeps the unreviewed-count query O(log unreviewed) instead
-- of scanning every appointment.
CREATE INDEX IF NOT EXISTS "Appointment_unreviewed_client_updates_idx"
  ON "Appointment" ("clientStatusUpdatedAt" DESC)
  WHERE "clientStatusUpdatedAt" IS NOT NULL
    AND "clientStatusReviewedAt" IS NULL;
