-- Content-based dedup for the Slack channel delivery ledger.
--
-- Original ledger used sourceKey = "sheet:Master Table:{rowNumber}"
-- as the dedup key. Solid in theory — except a row's rowNumber
-- changes the moment Mary inserts a row above it (or deletes one).
-- The new rowNumber generates a new sourceKey, the unique index
-- doesn't catch it, and the appointment posts again. Symptom: same
-- appointment hitting the channel multiple times across the day.
--
-- Content fields are stable across row shuffles, so dedup-by-content
-- bypasses the issue entirely. Keeping the existing sourceKey index
-- intact for backwards compatibility with rows already in flight.
ALTER TABLE "SheetSlackDelivery"
    ADD COLUMN IF NOT EXISTS "customerPhone" TEXT,
    ADD COLUMN IF NOT EXISTS "apptDateTime" TIMESTAMP(3);

-- Composite index for the content-based dedup query at sync time.
-- Not unique because legacy rows have NULLs for these fields; the
-- sync path checks for an existing match before inserting and
-- relies on the lookup being fast, not on the constraint catching
-- a duplicate write.
CREATE INDEX IF NOT EXISTS "SheetSlackDelivery_content_dedup_idx"
    ON "SheetSlackDelivery"("channelId", "customerPhone", "apptDateTime");
