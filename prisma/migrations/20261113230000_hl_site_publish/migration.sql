-- Forge publishes a built site after a Yes in the Office (src/lib/hl/site-request.ts).
ALTER TABLE "HlSiteRequest" ADD COLUMN "liveUrl" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "publishedAt" TIMESTAMP(3);
