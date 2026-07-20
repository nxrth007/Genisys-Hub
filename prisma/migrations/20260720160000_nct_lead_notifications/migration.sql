-- Slack notification on every incoming NCT lead, not just failures.

ALTER TABLE "NctBillingSettings"
    ADD COLUMN "notifyEveryLead" BOOLEAN NOT NULL DEFAULT true;

-- Point the singleton at the existing alerts channel if it was never set,
-- so notifications work the moment this ships instead of silently no-op'ing.
UPDATE "NctBillingSettings"
    SET "alertChannel" = 'genisys-alerts'
    WHERE "alertChannel" IS NULL;
