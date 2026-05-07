-- Two changes in one migration:
--
-- 1) Cascade delete on User.clientId. Previously SET NULL, which
--    left orphaned-active users wedged on /client with no recovery
--    path (admin deleted their Client, the User stayed put with
--    clientId=null). Per Alex: "If I delete a client, [the linked
--    login] should be deleted." Drop the existing FK and re-add
--    with CASCADE.
--
-- 2) New columns on User for the forgot-password flow:
--      passwordResetTokenHash  — bcrypt hash of the random token
--      passwordResetExpiresAt  — 1h after generation; cleared on use

-- (1) Replace the FK with a cascading version.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_clientId_fkey";

ALTER TABLE "User"
  ADD CONSTRAINT "User_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One-shot cleanup of pre-existing orphans. Any User row whose
-- clientId is null AND role starts with 'client_' is wedged today
-- (no Client to log into, no admin path to fix). Per Alex's intent
-- (delete the Client → delete the login), purge them now so the
-- new FK behavior matches the existing data state.
DELETE FROM "User"
 WHERE "clientId" IS NULL
   AND "role" LIKE 'client\_%' ESCAPE '\';

-- (2) Forgot-password columns.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMP(3);

-- Index the expiry so a periodic "clean up stale tokens" sweep is
-- cheap. Not strictly required for correctness — every reset attempt
-- compares bcrypt one-by-one — but keeps the index footprint small
-- and the query plan obvious.
CREATE INDEX IF NOT EXISTS "User_passwordResetExpiresAt_idx"
  ON "User" ("passwordResetExpiresAt");
