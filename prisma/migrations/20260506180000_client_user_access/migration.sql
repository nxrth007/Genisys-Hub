-- Client-access feature: lets a Client log in to /client and see only
-- their own appointments. Phase 1 covers existing-client logins (admin
-- generates a temp password from the Credentials tab); the self-
-- registration + onboarding flow lands in Phase 2.

-- Forces a password change on next sign-in. Set true when admin
-- generates a temp password for a client; cleared the moment the user
-- picks their own.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Links a client_* user to its Client row. Null for staff and agents.
-- ON DELETE SET NULL so removing a Client doesn't cascade-delete the
-- login (admin will tidy up manually, and we keep the row for audit
-- purposes if needed).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "clientId" TEXT;

-- Index on clientId so /client's appointment query plus admin's
-- "list logins for this client" lookup both stay snappy as the
-- client-user count grows.
CREATE INDEX IF NOT EXISTS "User_clientId_idx" ON "User"("clientId");

-- Defer the FK constraint until after the column + index exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_clientId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
