-- Add Client.package + Client.apptCap so admins can pin each
-- client to a contract tier (PPA / Growth / Pro / Custom) and the
-- Clients page can render a "12/20 delivered" progress bar.
--
-- Why two columns instead of just one:
--   * `package` is the human label and drives the default cap
--     (Growth → 20, Pro → 30). Stored as text rather than a
--     Postgres enum so a new tier (or rename) doesn't require
--     another migration.
--   * `apptCap` is the actual numeric target — null means
--     unlimited. PPA defaults to null. Sit-down guarantee deals
--     can set it to whatever the contract specifies, and admins
--     can override the package default for bespoke arrangements.
--
-- Existing rows default to `package = 'custom'` + `apptCap = NULL`
-- so nobody's data changes shape until an admin explicitly picks
-- a tier. That keeps the cap progress bar dim ("—") for clients
-- that haven't been categorized yet, instead of pretending they
-- have an unlimited deal.
ALTER TABLE "Client"
    ADD COLUMN IF NOT EXISTS "package" TEXT NOT NULL DEFAULT 'custom',
    ADD COLUMN IF NOT EXISTS "apptCap" INTEGER;
