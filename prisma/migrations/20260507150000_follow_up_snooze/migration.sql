-- Snooze on FollowUpDismissal. NULL = permanent dismiss (the
-- existing binary semantic, preserved for backward-compat with rows
-- inserted before this migration). When set, the unifier treats
-- the dismissal as inactive once the timestamp passes, so the row
-- re-surfaces for a fresh decision.
ALTER TABLE "FollowUpDismissal"
  ADD COLUMN IF NOT EXISTS "snoozeUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "FollowUpDismissal_snoozeUntil_idx"
  ON "FollowUpDismissal" ("snoozeUntil");
