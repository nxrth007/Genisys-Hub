-- Which rules checked a site form (src/lib/ghl-form/queue.ts FORM_VERSION): older checks are done again.
ALTER TABLE "GhlFormJob" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
