-- Cache layer for Google Solar API responses. Each row represents a
-- single billable API call ever made for that normalized address —
-- subsequent agent clicks for the same property hit cache and don't
-- re-bill. Solar imagery refreshes yearly at most, so an effectively-
-- forever cache is fine; admins can manually clear rows if Google
-- ships better data and they want a fresh fetch.
CREATE TABLE IF NOT EXISTS "SolarInsightsCache" (
    "id"             TEXT NOT NULL,
    "addressKey"     TEXT NOT NULL,
    "rawAddress"     TEXT NOT NULL,
    "latitude"       DOUBLE PRECISION,
    "longitude"      DOUBLE PRECISION,
    "imageryQuality" TEXT,
    "payload"        JSONB NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SolarInsightsCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_solar_insights_address_key"
    ON "SolarInsightsCache"("addressKey");

CREATE INDEX IF NOT EXISTS "SolarInsightsCache_createdAt_idx"
    ON "SolarInsightsCache"("createdAt");
