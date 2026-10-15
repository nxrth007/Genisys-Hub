-- GHL refuses creating sub-accounts by API on Agency Unlimited, so the
-- automation is switched off until the plan allows it (Settings turns it back on).
UPDATE "AppSetting"
SET "value" = replace("value", '"enabled":true', '"enabled":false')
WHERE "key" = 'ghlSubaccounts.settings';
