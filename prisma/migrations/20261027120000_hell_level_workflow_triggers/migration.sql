-- AlterTable
ALTER TABLE "HlWorkflow" ADD COLUMN "triggers" JSONB NOT NULL DEFAULT '[]';
