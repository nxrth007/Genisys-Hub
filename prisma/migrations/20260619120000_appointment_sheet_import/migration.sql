-- Sheet-import tracking on Appointment. Lets sheet-only appointments
-- (e.g. Brighton Capital's, which never went through the Hub form) be
-- imported as first-class DB rows so clients can view + status-update
-- them. importedFromSheet flags them; importSourceKey dedups the
-- importer. Pure ADD COLUMN with safe defaults — no data writes.

ALTER TABLE "Appointment"
  ADD COLUMN "importedFromSheet" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "importSourceKey" TEXT;

CREATE UNIQUE INDEX "Appointment_importSourceKey_key"
  ON "Appointment"("importSourceKey");
