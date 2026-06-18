-- Temporarily disable client-facing call-recording links (Alex,
-- 2026-06-17 — "doing more harm than good for now"). Gates the
-- client Slack post, client email, and client dashboard "Listen"
-- button. Internal/admin/agent playback is unaffected. Reversible by
-- flipping this value to 'true' (Settings toggle or direct update).
INSERT INTO "AppSetting" ("key", "value")
VALUES ('clientRecordingLinks.enabled', 'false')
ON CONFLICT ("key") DO UPDATE SET "value" = 'false';
