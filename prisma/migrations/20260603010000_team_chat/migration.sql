-- Internal team chat schema — replaces Microsoft Teams for Mary's
-- Team #1 agents. Three models: ChatChannel (one row per channel,
-- v1 ships with a single team-1-general), ChatMessage (text +
-- denormalized sender snapshot), ChatAttachment (photo bytes,
-- 30-day expiration handled by the scheduler tick).

CREATE TABLE IF NOT EXISTS "ChatChannel" (
  "id"         TEXT          PRIMARY KEY,
  "slug"       TEXT          NOT NULL UNIQUE,
  "name"       TEXT          NOT NULL,
  "teamNumber" INTEGER       NOT NULL,
  "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ChatMessage" (
  "id"          TEXT          PRIMARY KEY,
  "channelId"   TEXT          NOT NULL,
  "senderId"    TEXT,
  "senderName"  TEXT          NOT NULL,
  "senderImage" TEXT,
  "text"        TEXT          NOT NULL,
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ChatAttachment" (
  "id"        TEXT          PRIMARY KEY,
  "messageId" TEXT          NOT NULL,
  "filename"  TEXT          NOT NULL,
  "mimeType"  TEXT          NOT NULL,
  "sizeBytes" INTEGER       NOT NULL,
  "content"   BYTEA         NOT NULL,
  "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

-- FKs --
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatMessage_channelId_fkey') THEN
    ALTER TABLE "ChatMessage"
      ADD CONSTRAINT "ChatMessage_channelId_fkey"
      FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatMessage_senderId_fkey') THEN
    ALTER TABLE "ChatMessage"
      ADD CONSTRAINT "ChatMessage_senderId_fkey"
      FOREIGN KEY ("senderId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatAttachment_messageId_fkey') THEN
    ALTER TABLE "ChatAttachment"
      ADD CONSTRAINT "ChatAttachment_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- Indexes --
CREATE INDEX IF NOT EXISTS "ChatMessage_channelId_createdAt_idx"
  ON "ChatMessage" ("channelId", "createdAt");
CREATE INDEX IF NOT EXISTS "ChatAttachment_messageId_idx"
  ON "ChatAttachment" ("messageId");
CREATE INDEX IF NOT EXISTS "ChatAttachment_createdAt_idx"
  ON "ChatAttachment" ("createdAt");

-- Seed the single Team #1 channel. ON CONFLICT keeps the migration
-- idempotent if anyone reruns it. The id is deterministic so the
-- API's "find or create" lookups have a stable target.
INSERT INTO "ChatChannel" ("id", "slug", "name", "teamNumber", "createdAt")
VALUES (
  'chat-channel-team-1-general',
  'team-1-general',
  'Team #1 General',
  1,
  NOW()
)
ON CONFLICT ("slug") DO NOTHING;
