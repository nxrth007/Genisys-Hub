-- Phase 2 of client-access: capture the list of zipcodes a self-
-- onboarding client wants to service. Free-text (comma- or whitespace-
-- separated) for now — admin reviews + edits in the existing client
-- detail dialog. Nullable because legacy + admin-created clients
-- don't always have a fixed service area.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "servicingZipcodes" TEXT;
