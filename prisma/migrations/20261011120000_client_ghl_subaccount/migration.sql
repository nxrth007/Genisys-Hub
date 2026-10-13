-- The GHL sub-account created automatically for a new onboarding submission.
-- See src/lib/ghl-subaccount-provisioning.ts.
ALTER TABLE "Client" ADD COLUMN "ghlLocationId" TEXT;
ALTER TABLE "Client" ADD COLUMN "ghlProvisionStatus" TEXT;
ALTER TABLE "Client" ADD COLUMN "ghlProvisionError" TEXT;
ALTER TABLE "Client" ADD COLUMN "ghlProvisionedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "ghlSnapshotStatus" TEXT;

CREATE UNIQUE INDEX "Client_ghlLocationId_key" ON "Client"("ghlLocationId");
