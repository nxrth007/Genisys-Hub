-- Free-text "booked by" field on Appointment so Mary (the only Hub
-- user actually booking now) can record which of her call-center
-- agents took the call. The Hub's existing agentUserId still points
-- at the user who created the row (Mary); bookedByName is the
-- human-readable agent name that flows out to the master sheet's
-- existing Agent Name column and to client-facing displays.
-- Falls back to the booking user's own name when null.
ALTER TABLE "Appointment"
    ADD COLUMN IF NOT EXISTS "bookedByName" TEXT;
