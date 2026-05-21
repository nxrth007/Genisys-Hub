-- Team #N member fields. Per Alex's 2026-05-20 spec, Mary's call
-- center is getting its own roster of agents ("Team #1") that
-- registers + signs in through a separate flow, has zero access to
-- the master tracker / client data / booking surface, and only
-- exists to file End-of-Day reports.
--
-- The three new columns are all nullable so this migration is purely
-- additive — existing rows (staff, regular agents, clients) keep
-- their values unchanged. No backfill required.
--
--   servicingState  — US state the team agent is calling for. Set on
--                     registration; editable from /team/profile.
--   whatsappNumber  — preferred contact line for admin coordination
--                     with the team agent. Free-text; editable from
--                     /team/profile.
--   teamNumber      — which team this user belongs to. Team #1 members
--                     get 1; reserved for future Team #2+. The
--                     manager-of-each-team mapping lives in the
--                     TEAM_MANAGER_EMAILS env var (JSON), not the DB,
--                     so changes to who manages each team don't
--                     require a deploy.
--
-- Role values added in this release (no schema change — role is a
-- free-text String): team_pending / team_member / team_denied.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "servicingState" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "teamNumber" INTEGER;

-- Index on teamNumber so "list all approved members of team N"
-- queries (used by Mary's manager view + the admin Team #1 Pending
-- panel + the /call-center/eod-reports team chip) are cheap. Partial
-- index — most rows are NULL and don't need to be indexed.
CREATE INDEX IF NOT EXISTS "User_teamNumber_idx"
  ON "User" ("teamNumber")
  WHERE "teamNumber" IS NOT NULL;
