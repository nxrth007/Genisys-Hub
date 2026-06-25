-- Dispatch lifecycle as its own Hub-only field, separate from the
-- sheet-backed `status`. "Dispatched" moves OFF the regular status
-- dropdown and onto this one; the automation gate moves with it.
--
-- ADD COLUMN with a NOT NULL default backfills every existing row to
-- 'not_dispatched' (safe, no id/INSERT). Then any appointment an agent
-- already marked status='dispatched' under the prior flow is migrated:
-- its dispatch state is preserved on the new field and its regular
-- status is reverted to 'booked' (what it was before being dispatched).

ALTER TABLE "Appointment"
  ADD COLUMN "dispatchStatus" TEXT NOT NULL DEFAULT 'not_dispatched';

UPDATE "Appointment"
SET "dispatchStatus" = 'dispatched', "status" = 'booked'
WHERE "status" = 'dispatched';
