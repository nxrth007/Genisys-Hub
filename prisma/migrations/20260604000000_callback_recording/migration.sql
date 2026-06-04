-- Optional Vicidial call-recording URL on callbacks. Same paste-
-- from-dialer flow agents use for appointments, surfaced via the
-- existing signed proxy (lib/recording-proxy.ts) so admin can
-- listen back during QA. Null is the steady-state for most
-- callbacks; only the ones flagged for review need it set.

ALTER TABLE "Callback"
  ADD COLUMN IF NOT EXISTS "callRecordingLink" TEXT;
