-- Extend the Client table with primary-contact + relationship metadata
-- so the Clients tab can act as a real CRM card per client (name, phone,
-- email, notes, status). All new columns are nullable except `lifecycle`,
-- which defaults to 'active' so existing rows are valid.
--
-- Idempotent via IF NOT EXISTS so re-running the migration is harmless.

ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "contactName"      TEXT,
  ADD COLUMN IF NOT EXISTS "contactRole"      TEXT,
  ADD COLUMN IF NOT EXISTS "contactEmail"     TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone"     TEXT,
  ADD COLUMN IF NOT EXISTS "address"          TEXT,
  ADD COLUMN IF NOT EXISTS "notes"            TEXT,
  ADD COLUMN IF NOT EXISTS "intakeFormUrl"    TEXT,
  ADD COLUMN IF NOT EXISTS "ghlSubaccountUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycle"        TEXT NOT NULL DEFAULT 'active';
