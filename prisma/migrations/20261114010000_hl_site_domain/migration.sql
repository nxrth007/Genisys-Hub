-- Forge connects the client's domain to the published site (src/lib/hl/site-request.ts).
ALTER TABLE "HlSiteRequest" ADD COLUMN "domain" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainStep" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainMessageId" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainThreadId" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainTxt" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainWwwTxt" TEXT;
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainStepAt" TIMESTAMP(3);
ALTER TABLE "HlSiteRequest" ADD COLUMN "domainAt" TIMESTAMP(3);
