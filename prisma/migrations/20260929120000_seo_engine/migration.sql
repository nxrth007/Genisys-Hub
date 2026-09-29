-- SEO engine: sites, weekly runs, and the post ledger.
CREATE TABLE "SeoSite" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "liveUrl" TEXT,
    "repoFullName" TEXT,
    "defaultBranch" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'unknown',
    "mode" TEXT NOT NULL DEFAULT 'review',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "facts" JSONB,
    "gscProperty" TEXT,
    "lovableProjectId" TEXT,
    "indexNowKey" TEXT,
    "foundationStatus" TEXT NOT NULL DEFAULT 'none',
    "foundationPrUrl" TEXT,
    "lastScore" INTEGER,
    "lastRunAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoSite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoSite_clientId_key" ON "SeoSite"("clientId");
CREATE INDEX "SeoSite_archivedAt_idx" ON "SeoSite"("archivedAt");

ALTER TABLE "SeoSite" ADD CONSTRAINT "SeoSite_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SeoRun" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weekly',
    "weekOf" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'collect',
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "score" INTEGER,
    "headline" TEXT,
    "findingCounts" JSONB,
    "draftCount" INTEGER NOT NULL DEFAULT 0,
    "repoFullName" TEXT,
    "snapshot" JSONB,
    "audit" JSONB,
    "research" JSONB,
    "plan" JSONB,
    "drafts" JSONB,
    "changes" JSONB,
    "branch" TEXT,
    "commitSha" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "ciStatus" TEXT,
    "mergedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usage" JSONB,
    "log" JSONB,
    "reviewedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoRun_siteId_kind_weekOf_key" ON "SeoRun"("siteId", "kind", "weekOf");
CREATE INDEX "SeoRun_status_idx" ON "SeoRun"("status");
CREATE INDEX "SeoRun_siteId_createdAt_idx" ON "SeoRun"("siteId", "createdAt");

ALTER TABLE "SeoRun" ADD CONSTRAINT "SeoRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SeoPost" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "runId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primaryKeyword" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "url" TEXT,
    "path" TEXT,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoPost_siteId_slug_key" ON "SeoPost"("siteId", "slug");
CREATE INDEX "SeoPost_siteId_status_idx" ON "SeoPost"("siteId", "status");

ALTER TABLE "SeoPost" ADD CONSTRAINT "SeoPost_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "SeoSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
