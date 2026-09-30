-- Whether the site repo has the engine's build check, for the Autopilot readiness list.
ALTER TABLE "SeoSite" ADD COLUMN "ciWorkflow" BOOLEAN NOT NULL DEFAULT false;
