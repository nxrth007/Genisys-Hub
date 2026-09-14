-- Client onboarding form submissions from the intake webhook.
-- Parsed fields plus the verbatim payload, so unmapped answers survive.

CREATE TABLE "ClientIntake" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ein" TEXT,
    "fullName" TEXT,
    "businessName" TEXT,
    "businessContact" TEXT,
    "businessAddress" TEXT,
    "customerPhone" TEXT,
    "areaCode" TEXT,
    "timeZone" TEXT,
    "leadEmail" TEXT,
    "cities" TEXT,
    "website" TEXT,
    "aboutBusiness" TEXT,
    "mainServices" TEXT,
    "promotions" TEXT,
    "socialLinks" TEXT,
    "whyChooseYou" TEXT,
    "brandColors" TEXT,
    "faqs" TEXT,
    "raw" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientIntake_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientIntake_receivedAt_idx" ON "ClientIntake"("receivedAt");
CREATE INDEX "ClientIntake_status_idx" ON "ClientIntake"("status");
CREATE INDEX "ClientIntake_leadEmail_idx" ON "ClientIntake"("leadEmail");

ALTER TABLE "ClientIntake" ADD CONSTRAINT "ClientIntake_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
