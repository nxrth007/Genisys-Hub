-- Reminder reply alerts — dedup ledger for customer replies to
-- reminder SMS threads. Pairs with the copy refresh that added the
-- "Reply Y to confirm or N to reschedule" ask: this table backs the
-- scheduler job that catches those replies and pings Slack so the
-- call center can act on an "N" while the slot is still savable.

CREATE TABLE "ReminderReplyAlert" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "messageBody" TEXT,
    "messageDate" TIMESTAMP(3),
    "classification" TEXT NOT NULL DEFAULT 'other',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "clientName" TEXT,
    "apptDateTime" TIMESTAMP(3),
    "slackChannelId" TEXT,
    "slackMessageTs" TEXT,
    "permalink" TEXT,
    "alertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderReplyAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReminderReplyAlert_conversationId_idx" ON "ReminderReplyAlert"("conversationId");

CREATE UNIQUE INDEX "ux_reminder_reply_conv_msg" ON "ReminderReplyAlert"("conversationId", "messageId");
