-- Clients table + Appointment.clientId. The call center books for multiple
-- Genisys clients; each appointment identifies which one. Seeds the two
-- current clients so the app works out of the box post-deploy.
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- Seed: Brighton Capital Solar (Arizona) + Spring Solar (Utah). Stable IDs
-- so logs / spreadsheet exports reference predictable strings. Re-running
-- the migration is a no-op thanks to ON CONFLICT.
INSERT INTO "Client" ("id", "name", "state", "color", "sortOrder", "updatedAt")
VALUES
  ('cli_brighton_capital_solar', 'Brighton Capital Solar', 'Arizona', '#f59e0b', 0, CURRENT_TIMESTAMP),
  ('cli_spring_solar', 'Spring Solar', 'Utah', '#10b981', 1, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- Nullable to keep the migration safe; the API enforces required-on-create
-- for new appointments in code rather than at the schema level.
ALTER TABLE "Appointment" ADD COLUMN "clientId" TEXT;

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Appointment_clientId_idx" ON "Appointment"("clientId");
