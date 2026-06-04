-- Phase 1 of the Team #1 sign-in cutover.
--
-- Adds two columns to User so Team #1 agents can sign in with an
-- assigned call-center number instead of an email address:
--
--   callCenterNumber       — the new username for Team #1. Unique
--                             when set (partial index — non-team
--                             users keep NULL). Assigned by admin
--                             via /admin/agents/[id] after approval.
--   registrationLookupCode — 6-char code shown to the user on the
--                             "registration received" screen so they
--                             can tell their supervisor which
--                             pending record is theirs. Cleared
--                             when the row is approved.
--
-- Email column is left intact + still required at the schema level
-- because (a) NextAuth's PrismaAdapter assumes User.email exists
-- for Google SSO, and (b) the agent/client sign-in flows still use
-- it. New Team #1 rows synthesize a placeholder email like
-- `<lookupCode>@team1.local` to satisfy the @unique constraint
-- without exposing the user to email anywhere — see the register
-- route for the synthesis logic.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "callCenterNumber"       TEXT,
  ADD COLUMN IF NOT EXISTS "registrationLookupCode" TEXT;

-- Partial unique index — matches the pattern used by the
-- teamNumber column added 2026-05-20. Existing rows with null
-- callCenterNumber don't trip the constraint, and assignment
-- (admin sets a digit string) is uniqueness-checked at the DB
-- level.
CREATE UNIQUE INDEX IF NOT EXISTS "User_callCenterNumber_unique_idx"
  ON "User" ("callCenterNumber")
  WHERE "callCenterNumber" IS NOT NULL;

-- registrationLookupCode is intentionally NOT unique — collisions
-- are astronomically unlikely at the 6-char-cuid-suffix level and
-- the code is just an admin-side disambiguator, not an auth
-- credential. If a collision ever DID happen, admin would simply
-- see two pending rows with the same code and ask the user for a
-- second identifier (name, state).
