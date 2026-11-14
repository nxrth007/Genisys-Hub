-- What Lovable is paused on during a website build (a question or a tool to approve), and
-- what Forge made of it (src/lib/hl/site-pause.ts).
ALTER TABLE "HlSiteRequest" ADD COLUMN "pause" JSONB;
