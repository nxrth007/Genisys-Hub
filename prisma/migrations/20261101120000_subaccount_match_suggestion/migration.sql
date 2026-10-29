-- CreateTable
CREATE TABLE "SubaccountMatchSuggestion" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubaccountMatchSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubaccountMatchSuggestion_clientId_locationId_key" ON "SubaccountMatchSuggestion"("clientId", "locationId");

-- CreateIndex
CREATE INDEX "SubaccountMatchSuggestion_status_idx" ON "SubaccountMatchSuggestion"("status");

-- AddForeignKey
ALTER TABLE "SubaccountMatchSuggestion" ADD CONSTRAINT "SubaccountMatchSuggestion_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
