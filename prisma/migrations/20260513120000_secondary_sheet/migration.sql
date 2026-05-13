-- SecondarySheet registry. Additional Google Sheets that feed the
-- Master Tracker beyond the primary "Master Table." Each row maps a
-- spreadsheet+tab to a single Client, with a column-mapping preset
-- key picking how to parse rows (see lib/secondary-sheets.ts).
--
-- Seeded with the two Yassin-run sheets that prompted this work
-- (Forward Energy Solutions + Brighton Capital Solar) so ingestion
-- works immediately on deploy. Admin UI for adding more comes in a
-- separate commit.

CREATE TABLE "SecondarySheet" (
    "id" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "tabTitle" TEXT NOT NULL DEFAULT 'Sheet1',
    "clientId" TEXT,
    "columnMappingKey" TEXT NOT NULL DEFAULT 'yassin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecondarySheet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_secondary_sheet_sheet_tab"
    ON "SecondarySheet"("spreadsheetId", "tabTitle");

CREATE INDEX "SecondarySheet_clientId_idx" ON "SecondarySheet"("clientId");
CREATE INDEX "SecondarySheet_enabled_idx" ON "SecondarySheet"("enabled");

ALTER TABLE "SecondarySheet"
    ADD CONSTRAINT "SecondarySheet_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
