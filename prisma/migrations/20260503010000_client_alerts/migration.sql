-- "Client Alerts" feature: SMS notification to a client's contactPhone
-- whenever a new appointment lands in the master sheet for them. Mirrors
-- the SheetSlackDelivery cron flow but over SMS via GHL — both fire
-- independently in the same 5-min cron tick so a Slack outage doesn't
-- suppress the SMS and vice versa.

-- Singleton config row. Default off — admin opts in via Settings, which
-- triggers a backfill that marks every existing master-sheet row as
-- 'backfilled' so first-enable doesn't blast historical bookings.
CREATE TABLE IF NOT EXISTS "ClientAlertsConfig" (
    "id"            TEXT NOT NULL DEFAULT 'singleton',
    "enabled"       BOOLEAN NOT NULL DEFAULT false,
    -- Vault entry name for the GHL JWT token used to send SMS. Same
    -- default as RemindersConfig so a single rotation handles both.
    "vaultEntryName" TEXT NOT NULL DEFAULT 'GHL Genisys Token',
    -- Optional E.164 sender override (e.g. "+16038034828"). Null falls
    -- back to the GHL location's default phone, which is what every
    -- deployment did before this column existed.
    "senderPhone"   TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientAlertsConfig_pkey" PRIMARY KEY ("id")
);

-- Idempotency ledger — parallel to SheetSlackDelivery. Same dual-key
-- dedup story (sourceKey + content key with a recency window applied
-- in the sync code), separate row so the two channels don't smash each
-- other's history on retry.
--
-- status:
--   delivered  — GHL acknowledged the SMS; messageId is set
--   backfilled — pre-existing sheet row at first-enable; never sent
--   failed     — last attempt failed; errorMessage holds the cause
CREATE TABLE IF NOT EXISTS "ClientAlertDelivery" (
    "id"            TEXT NOT NULL,
    "sourceKey"     TEXT NOT NULL,
    "clientId"      TEXT,
    -- The recipient phone we actually sent to (normalized E.164). Stored
    -- so a later contactPhone change on the Client doesn't hide the
    -- audit trail of what actually went out.
    "recipientPhone" TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'delivered',
    -- GHL message id from /conversations/messages POST response. Used
    -- with /conversations/messages/{id} to verify final delivery state.
    "messageId"     TEXT,
    -- GHL conversation id — handy for jumping to the thread in GHL UI
    -- if a reply comes in.
    "conversationId" TEXT,
    "errorMessage"  TEXT,
    "deliveredAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    -- Content-based dedup pair (parallel to SheetSlackDelivery).
    "customerPhone" TEXT,
    "apptDateTime"  TIMESTAMP(3),
    CONSTRAINT "ClientAlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_client_alert_delivery_source_recipient"
    ON "ClientAlertDelivery"("sourceKey", "recipientPhone");

CREATE INDEX IF NOT EXISTS "ClientAlertDelivery_clientId_idx"
    ON "ClientAlertDelivery"("clientId");

CREATE INDEX IF NOT EXISTS "ClientAlertDelivery_status_idx"
    ON "ClientAlertDelivery"("status");

CREATE INDEX IF NOT EXISTS "ClientAlertDelivery_content_dedup_idx"
    ON "ClientAlertDelivery"("recipientPhone", "customerPhone", "apptDateTime");
