-- Additive only: DB copy of the Client Onboarding Tracker sheet.
-- CreateTable
CREATE TABLE "ClientTracker" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT,
    "business" TEXT,
    "contactEmail" TEXT,
    "startDate" TEXT,
    "signupStatus" TEXT NOT NULL DEFAULT 'pending',
    "intakeStatus" TEXT NOT NULL DEFAULT 'pending',
    "automationsStatus" TEXT NOT NULL DEFAULT 'pending',
    "a2pStatus" TEXT NOT NULL DEFAULT 'pending',
    "tollFreeStatus" TEXT NOT NULL DEFAULT 'pending',
    "extra" JSONB,
    "source" TEXT NOT NULL DEFAULT 'hub',
    "sheetRow" INTEGER,
    "sheetSyncedAt" TIMESTAMP(3),
    "publicTokenNonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientTracker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientTracker_clientId_key" ON "ClientTracker"("clientId");

-- AddForeignKey
ALTER TABLE "ClientTracker" ADD CONSTRAINT "ClientTracker_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
