-- The lead-alert snapshot, loaded into No EIN clients' sub-accounts by the Hub.
ALTER TABLE "Client" ADD COLUMN "leadAlertInstallStatus" TEXT;
ALTER TABLE "Client" ADD COLUMN "leadAlertInstallError" TEXT;
ALTER TABLE "Client" ADD COLUMN "leadAlertInstallAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "leadAlertSnapshotId" TEXT;
ALTER TABLE "ClientAlertsConfig" ADD COLUMN "leadAlertSnapshotId" TEXT;
