-- Seed the two SecondarySheet rows for Yassin's call center so the
-- Forward Energy Solutions + Brighton Capital Solar sheets start
-- ingesting immediately on deploy — without needing the admin UI
-- (which ships in a later commit).
--
-- Idempotent: ON CONFLICT (spreadsheetId, tabTitle) DO NOTHING. The
-- unique index from the prior migration backs this.
--
-- clientId is looked up by name. If the matching Client row doesn't
-- exist (rare — both clients should already be on the platform),
-- the INSERT skips itself via the `WHERE` clause; admin can add the
-- sheet manually via the admin UI later.

INSERT INTO "SecondarySheet" (
    "id",
    "spreadsheetId",
    "tabTitle",
    "clientId",
    "columnMappingKey",
    "enabled",
    "label",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    '1a9FJF_tAVpacXm_4k8HvtJseF3J7mWcYakhFP856xpo',
    'Sheet1',
    c.id,
    'yassin',
    true,
    'Yassin — Forward Energy Solutions',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Client" c
WHERE LOWER(c.name) = LOWER('Forward Energy Solutions')
ON CONFLICT ("spreadsheetId", "tabTitle") DO NOTHING;

INSERT INTO "SecondarySheet" (
    "id",
    "spreadsheetId",
    "tabTitle",
    "clientId",
    "columnMappingKey",
    "enabled",
    "label",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    '1qQjVyDFYycBK-jMWZPgxkxEeE22fJYOWhnQvdsXAX4A',
    'Sheet1',
    c.id,
    'yassin',
    true,
    'Yassin — Brighton Capital Solar',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Client" c
WHERE LOWER(c.name) = LOWER('Brighton Capital Solar')
ON CONFLICT ("spreadsheetId", "tabTitle") DO NOTHING;
