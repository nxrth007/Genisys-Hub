-- Track when the Slack Connect invite was emailed to the client's
-- contactEmail by lib/client-workspace.ts. NULL = not sent (either
-- contactEmail was missing, the API call failed, or this Client
-- pre-dates the auto-provisioning feature).
ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "slackInviteSentAt" TIMESTAMP(3);
