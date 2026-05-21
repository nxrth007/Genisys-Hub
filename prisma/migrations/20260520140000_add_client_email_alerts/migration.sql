-- "Email Client Alerts" feature — Spring Solar asked for email parity
-- with the existing SMS + Slack client-alert channels (2026-05-20).
-- Adds:
--   1. Client.emailAlertsEnabled  — per-client opt-in (default false)
--   2. ClientEmailAlertsConfig    — singleton row for the master toggle
--                                   + sender configuration
--   3. ClientEmailDelivery        — idempotency ledger (mirror of
--                                   ClientAlertDelivery for SMS)
-- Then seeds the master config row (enabled=TRUE so the feature is
-- live for accounts that have opted in) and flips Spring Solar to
-- emailAlertsEnabled=TRUE per Alex's spec ("only Spring on at
-- launch, everyone else off").
--
-- Purely additive — every new column / table is fresh. No existing
-- data is rewritten beyond the targeted Spring Solar UPDATE.

-- 1. Per-client opt-in flag.
ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "emailAlertsEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Singleton config table — master enable + sender configuration.
CREATE TABLE IF NOT EXISTS "ClientEmailAlertsConfig" (
  "id"               TEXT NOT NULL DEFAULT 'singleton',
  "enabled"          BOOLEAN NOT NULL DEFAULT FALSE,
  "fromGmailAccount" TEXT,
  "senderName"       TEXT,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientEmailAlertsConfig_pkey" PRIMARY KEY ("id")
);

-- 3. Idempotency ledger — parallel to ClientAlertDelivery (SMS).
CREATE TABLE IF NOT EXISTS "ClientEmailDelivery" (
  "id"             TEXT NOT NULL,
  "sourceKey"      TEXT NOT NULL,
  "clientId"       TEXT,
  "recipientEmail" TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'delivered',
  "scheduledFor"   TIMESTAMP(3),
  "messageId"      TEXT,
  "errorMessage"   TEXT,
  "deliveredAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "customerPhone"  TEXT,
  "apptDateTime"   TIMESTAMP(3),
  CONSTRAINT "ClientEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_client_email_delivery_source_recipient"
  ON "ClientEmailDelivery" ("sourceKey", "recipientEmail");

CREATE INDEX IF NOT EXISTS "ClientEmailDelivery_clientId_idx"
  ON "ClientEmailDelivery" ("clientId");

CREATE INDEX IF NOT EXISTS "ClientEmailDelivery_status_idx"
  ON "ClientEmailDelivery" ("status");

CREATE INDEX IF NOT EXISTS "ClientEmailDelivery_pending_due_idx"
  ON "ClientEmailDelivery" ("status", "scheduledFor");

CREATE INDEX IF NOT EXISTS "ClientEmailDelivery_content_dedup_idx"
  ON "ClientEmailDelivery" ("recipientEmail", "customerPhone", "apptDateTime");

ALTER TABLE "ClientEmailDelivery"
  ADD CONSTRAINT "ClientEmailDelivery_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Seed the master config so the feature is live without an admin
--    having to flip the toggle first. (Per-client opt-in still gates
--    individual sends — Spring Solar is the only seed with the flag
--    turned on; everyone else stays off until admin enables them.)
INSERT INTO "ClientEmailAlertsConfig" ("id", "enabled", "updatedAt")
VALUES ('singleton', TRUE, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 5. Spring Solar opt-in per Alex's launch spec. Case-insensitive
--    match on name so a stray capitalization in the seed doesn't
--    silently skip. No-op if Spring Solar doesn't exist (idempotent
--    across dev / staging / prod where the client roster differs).
UPDATE "Client"
   SET "emailAlertsEnabled" = TRUE
 WHERE LOWER("name") = LOWER('Spring Solar');
