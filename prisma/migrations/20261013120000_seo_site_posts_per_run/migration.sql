-- Per-site post counts for weekly runs: a standing override of the global
-- "posts per week", and a one-off for the next run. See src/lib/seo/pipeline.ts.
ALTER TABLE "SeoSite" ADD COLUMN "postsPerWeek" INTEGER;
ALTER TABLE "SeoSite" ADD COLUMN "postsNextRun" INTEGER;
