-- Roofing client tracking: contact details + notes on the billing config.

ALTER TABLE "NctBillingConfig" ADD COLUMN "contactName" TEXT;
ALTER TABLE "NctBillingConfig" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "NctBillingConfig" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "NctBillingConfig" ADD COLUMN "notes" TEXT;
