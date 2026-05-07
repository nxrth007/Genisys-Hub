-- Slack alerts for inbound client messages on the Genisys GHL sub-account.
-- One row per (conversation, message id) we've alerted on. Same dedup
-- pattern as SheetSlackDelivery / ClientAlertDelivery — if the cron
-- ticks twice on the same lastMessageId, the second insert hits the
-- unique constraint and we silently skip.

CREATE TABLE IF NOT EXISTS "ClientMessageAlert" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "conversationId"  TEXT NOT NULL,
  "clientId"        TEXT,
  "lastMessageId"   TEXT,
  "lastMessageDate" TIMESTAMP(3),
  "slackChannelId"  TEXT,
  "slackMessageTs"  TEXT,
  "permalink"       TEXT,
  "alertedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientMessageAlert_pkey" PRIMARY KEY ("id")
);

-- Index by conversation for fast "latest alert per conv" lookups.
CREATE INDEX IF NOT EXISTS "ClientMessageAlert_conversationId_idx"
  ON "ClientMessageAlert" ("conversationId");

-- Index by client so the future "client comms history" UI can
-- query without a full table scan.
CREATE INDEX IF NOT EXISTS "ClientMessageAlert_clientId_idx"
  ON "ClientMessageAlert" ("clientId");

-- Dedup: same conversation + same message id = same alert. Second
-- insert blows up with P2002 which the sync code treats as "already
-- alerted, skip."
CREATE UNIQUE INDEX IF NOT EXISTS "ux_client_msg_alert_conv_msg"
  ON "ClientMessageAlert" ("conversationId", "lastMessageId");

-- FK to Client (SET NULL so deleting a Client preserves the audit
-- record). Wrapped in DO block so the migration is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ClientMessageAlert_clientId_fkey'
  ) THEN
    ALTER TABLE "ClientMessageAlert"
      ADD CONSTRAINT "ClientMessageAlert_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
