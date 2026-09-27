-- Home globe: where each client is, and when their site went live.
ALTER TABLE "Client" ADD COLUMN "siteLiveAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "geoLat" DOUBLE PRECISION;
ALTER TABLE "Client" ADD COLUMN "geoLng" DOUBLE PRECISION;
ALTER TABLE "Client" ADD COLUMN "geoLabel" TEXT;
ALTER TABLE "Client" ADD COLUMN "geoStatus" TEXT;
ALTER TABLE "Client" ADD COLUMN "geoRetryAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "geocodedAt" TIMESTAMP(3);
-- Sites already recorded as live count from when they were recorded.
UPDATE "Client" SET "siteLiveAt" = "updatedAt" WHERE "siteUrl" IS NOT NULL AND "siteLiveAt" IS NULL;
