-- The onboarding form's "Help us get you found on Google" questions.
ALTER TABLE "ClientIntake" ADD COLUMN "hasGoogleProfile" TEXT;
ALTER TABLE "ClientIntake" ADD COLUMN "googleProfileLink" TEXT;
ALTER TABLE "ClientIntake" ADD COLUMN "yearStarted" TEXT;
ALTER TABLE "ClientIntake" ADD COLUMN "licenseInfo" TEXT;
ALTER TABLE "ClientIntake" ADD COLUMN "reviewLinks" TEXT;
