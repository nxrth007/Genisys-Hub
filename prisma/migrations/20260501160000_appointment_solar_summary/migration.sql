-- Snapshot of the Project Sunroof / Google Solar API summary at the
-- time the appointment was created, so we have an audit-trail of
-- what the roof looked like when Mary booked. Populated only when
-- the SolarInsightsCache already has an entry for the address (i.e.
-- Mary clicked "Check solar potential" in the form before saving) —
-- never triggers a fresh billable API call from the create handler.
ALTER TABLE "Appointment"
    ADD COLUMN IF NOT EXISTS "solarSummary" JSONB;
