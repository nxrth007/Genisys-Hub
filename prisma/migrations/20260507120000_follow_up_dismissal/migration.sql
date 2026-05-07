-- Per-user dismissal table for the /follow-ups view. Keyed by
-- (userId, threadKey) so each staff member maintains their own
-- "I handled this" state — Alex marking a Gmail thread handled
-- doesn't hide it from Ethan's view.
CREATE TABLE IF NOT EXISTS "FollowUpDismissal" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"       TEXT NOT NULL,
  "threadKey"    TEXT NOT NULL,
  "contactLabel" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FollowUpDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_follow_up_dismissal_user_thread"
  ON "FollowUpDismissal" ("userId", "threadKey");

CREATE INDEX IF NOT EXISTS "FollowUpDismissal_userId_idx"
  ON "FollowUpDismissal" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FollowUpDismissal_userId_fkey'
  ) THEN
    ALTER TABLE "FollowUpDismissal"
      ADD CONSTRAINT "FollowUpDismissal_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
