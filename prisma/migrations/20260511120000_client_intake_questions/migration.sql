-- Capture more onboarding intake answers on each Client so the
-- qualification criteria Mary references when booking are recorded
-- alongside the rest of the client record (instead of living only in
-- Mary's separate Google Sheet).
--   appointmentTypes        — "in_person" | "virtual" | "both"
--   bookWeekends            — boolean (Sat/Sun OK?)
--   website                 — optional business website URL
--   providesBatteryBackup   — boolean (installs battery backup?)
-- All nullable so existing rows are unaffected. The onboarding form
-- requires the booleans + appointmentTypes on submission, so newly-
-- onboarded clients always have values.
ALTER TABLE "Client" ADD COLUMN "appointmentTypes" TEXT;
ALTER TABLE "Client" ADD COLUMN "bookWeekends" BOOLEAN;
ALTER TABLE "Client" ADD COLUMN "website" TEXT;
ALTER TABLE "Client" ADD COLUMN "providesBatteryBackup" BOOLEAN;
