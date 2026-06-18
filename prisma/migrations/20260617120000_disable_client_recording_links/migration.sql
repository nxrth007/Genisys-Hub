-- Temporarily disable client-facing call-recording links (Alex,
-- 2026-06-17 — "doing more harm than good for now"). Gates the
-- client Slack post, client email, and client dashboard "Listen"
-- button. Internal/admin/agent playback is unaffected. Reversible by
-- the Settings toggle (flips this value to 'true').
--
-- NOTE: AppSetting.id is cuid()-defaulted in the Prisma CLIENT, not
-- the DB, so a raw INSERT must supply an explicit id — omitting it
-- hits a NOT NULL violation on "id" (this is what failed the first
-- attempt). Literal id is fine; it just needs to be unique.
INSERT INTO "AppSetting" ("id", "key", "value")
VALUES (
  'appset_client_recording_links',
  'clientRecordingLinks.enabled',
  'false'
)
ON CONFLICT ("key") DO UPDATE SET "value" = 'false';
