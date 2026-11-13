-- What numbers each linked client's GHL sub-account has (src/lib/ghl-number/census.ts).
CREATE TABLE "GhlNumberCensus" (
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "numbers" JSONB,
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3),
    "triedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GhlNumberCensus_pkey" PRIMARY KEY ("clientId")
);

ALTER TABLE "GhlNumberCensus" ADD CONSTRAINT "GhlNumberCensus_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
