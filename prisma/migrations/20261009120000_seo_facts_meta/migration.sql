-- Where each business fact came from (client form / team edit), the onboarding
-- submission last folded in, recent changes and open conflicts. See src/lib/seo/client-facts.ts.
ALTER TABLE "SeoSite" ADD COLUMN "factsMeta" JSONB;
