-- The GHL route also files GHL's toll-free registration form (src/lib/ghl-number/register-plan.ts).
ALTER TABLE "GhlNumberJob" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'number';
ALTER TABLE "GhlNumberJob" ADD COLUMN "registration" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "GhlNumberJob" ADD COLUMN "regDetail" TEXT;
ALTER TABLE "GhlNumberJob" ADD COLUMN "regAt" TIMESTAMP(3);
ALTER TABLE "GhlNumberJob" ADD COLUMN "regFields" JSONB;
