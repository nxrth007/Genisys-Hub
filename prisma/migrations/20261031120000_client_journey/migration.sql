-- CreateTable
CREATE TABLE "ClientJourneyStage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientJourneyStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientJourneyEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientJourneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientJourneyStage_clientId_stage_key" ON "ClientJourneyStage"("clientId", "stage");

-- CreateIndex
CREATE INDEX "ClientJourneyStage_stage_status_idx" ON "ClientJourneyStage"("stage", "status");

-- CreateIndex
CREATE INDEX "ClientJourneyEvent_clientId_createdAt_idx" ON "ClientJourneyEvent"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientJourneyStage" ADD CONSTRAINT "ClientJourneyStage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientJourneyEvent" ADD CONSTRAINT "ClientJourneyEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
