-- County the customer lives in, auto-derived from the address via
-- Google geocoding at booking + on address edits. Nullable, no
-- default, no backfill — pure ADD COLUMN, safe (no id/NOT NULL trap).
ALTER TABLE "Appointment" ADD COLUMN "county" TEXT;
