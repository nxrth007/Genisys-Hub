-- The onboarding form now asks whether the client brings their own domain.
ALTER TABLE "ClientIntake" ADD COLUMN "bringingOwnDomain" TEXT;
ALTER TABLE "ClientIntake" ADD COLUMN "domainName" TEXT;
