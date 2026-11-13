-- Reads from before GHL's "No Data" was waited out (version 1) are read again (src/lib/ghl-number/census-plan.ts).
ALTER TABLE "GhlNumberCensus" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
