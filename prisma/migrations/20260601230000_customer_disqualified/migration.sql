-- Boolean column for the conditional "Customer Disqualified?"
-- question that appears in the client status-report modal after
-- the client picks "Showed up". Null when the client hasn't
-- answered (either because they only ever picked no-show, or the
-- field didn't exist yet at the time of their last update).
--
-- We deliberately use a 3-valued boolean (true / false / null)
-- rather than NOT NULL DEFAULT false because we want to tell
-- "answered no" apart from "didn't answer" — useful both for
-- back-filling old appointments and for reporting (the "% of
-- showed appointments that got DQ'd" stat should ignore null
-- rows, not lump them in with the "qualified" pile).

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "customerDisqualified" BOOLEAN;
