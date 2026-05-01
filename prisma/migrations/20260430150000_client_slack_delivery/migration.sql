-- Per-client Slack delivery routing. When slackChannelId is set on a
-- Client row, new appointments for that client get auto-posted to the
-- channel from the cron sync tick. slackChannelName is a cached label
-- so the Settings UI can render the current selection without a
-- round-trip to Slack.
ALTER TABLE "Client"
    ADD COLUMN IF NOT EXISTS "slackChannelId" TEXT,
    ADD COLUMN IF NOT EXISTS "slackChannelName" TEXT;

-- Idempotency ledger for client-channel deliveries. One row per
-- (sourceKey, channelId) — the channelId is part of the key so a
-- channel reroute (rare) starts a fresh delivery history rather than
-- silently swallowing future posts.
--
-- status:
--   delivered  — successfully posted to Slack; messageTs is set
--   backfilled — pre-existing sheet row at the time the channel was
--                first configured. Never posted; recorded so the sync
--                doesn't blast historical rows on first deploy.
--   failed     — last attempt failed; errorMessage holds the cause
CREATE TABLE IF NOT EXISTS "SheetSlackDelivery" (
    "id"            TEXT NOT NULL,
    "sourceKey"     TEXT NOT NULL,
    "clientId"      TEXT,
    "channelId"     TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'delivered',
    "messageTs"     TEXT,
    "errorMessage"  TEXT,
    "deliveredAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SheetSlackDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_sheet_slack_delivery_source_channel"
    ON "SheetSlackDelivery"("sourceKey", "channelId");

CREATE INDEX IF NOT EXISTS "SheetSlackDelivery_clientId_idx"
    ON "SheetSlackDelivery"("clientId");

CREATE INDEX IF NOT EXISTS "SheetSlackDelivery_status_idx"
    ON "SheetSlackDelivery"("status");
