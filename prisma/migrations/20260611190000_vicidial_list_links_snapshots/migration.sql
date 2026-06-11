-- Vicidial list → Client mapping + daily burn-down snapshots.
-- Backs the /leads client grouping and the list-depletion history.

CREATE TABLE "VicidialListLink" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VicidialListLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VicidialListLink_listId_key" ON "VicidialListLink"("listId");
CREATE INDEX "VicidialListLink_clientId_idx" ON "VicidialListLink"("clientId");

ALTER TABLE "VicidialListLink"
    ADD CONSTRAINT "VicidialListLink_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "VicidialListSnapshot" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "snapshotDay" TEXT NOT NULL,
    "total" INTEGER,
    "newCount" INTEGER,
    "statusJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VicidialListSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_vicidial_snapshot_list_day" ON "VicidialListSnapshot"("listId", "snapshotDay");
CREATE INDEX "VicidialListSnapshot_listId_idx" ON "VicidialListSnapshot"("listId");
