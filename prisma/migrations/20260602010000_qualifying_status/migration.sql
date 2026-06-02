-- Adds Appointment.qualifyingStatusUpdatedAt — the source of truth
-- for "is this appointment billable" in the PPA invoicing
-- automation.
--
-- Set only when an admin / member / client_active actor moves the
-- status to one of {showed, won, lost}. Mary (role=agent) cannot
-- stamp this field; her advisory marks never trigger an invoice
-- per Alex's 2026-06-02 spec.
--
-- Backfill: any existing appointment that has clientStatusUpdatedAt
-- AND a billable status receives the same timestamp here, so the
-- already-shipped invoicing automation behaves correctly without
-- requiring clients to re-click every prior update. Status-only
-- migrations done in the call center (admin/member without going
-- through the client dashboard) are NOT backfilled — those rows
-- have no clean signal to preserve, and per Alex the cutoff
-- (invoicingCutoffAt) already excludes them from billing anyway.

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "qualifyingStatusUpdatedAt" TIMESTAMP(3);

UPDATE "Appointment"
SET "qualifyingStatusUpdatedAt" = "clientStatusUpdatedAt"
WHERE "clientStatusUpdatedAt" IS NOT NULL
  AND "status" IN ('showed', 'won', 'lost')
  AND "qualifyingStatusUpdatedAt" IS NULL;
