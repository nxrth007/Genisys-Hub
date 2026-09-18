-- Uploaded files (signed URLs) arrive as a list on the new envelope payload.
ALTER TABLE "ClientIntake" ADD COLUMN "files" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
