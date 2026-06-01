-- Client-reported appointment status fields. Lets the agency client
-- (not the homeowner) update their own dashboard with whether the
-- prospect showed up + add free-form notes, without overwriting
-- Mary's notes / status snapshot.
--
-- Two additive columns; no backfill required, no risk to existing
-- rows. The actual status transition (booked → showed | no_show)
-- still writes to Appointment.status — these two columns are
-- companions that capture the WHO + WHEN of the client's update
-- plus their own free-form context.

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "clientNotes" TEXT;

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "clientStatusUpdatedAt" TIMESTAMP(3);
