-- Seed the third Genisys client: Energy Upgrade (California). Sky-blue
-- accent so it reads distinct from Brighton (amber) and Spring (emerald)
-- in the per-client filters and badges. ON CONFLICT keeps the migration
-- safe to re-run.
INSERT INTO "Client" ("id", "name", "state", "color", "sortOrder", "updatedAt")
VALUES
  ('cli_energy_upgrade', 'Energy Upgrade', 'California', '#0ea5e9', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
