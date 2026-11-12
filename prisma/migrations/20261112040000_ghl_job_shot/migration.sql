-- Page images from the sub-account browser worker. The job log names
-- each row; older shots for the same job are deleted by the worker.
CREATE TABLE "GhlSubaccountJobShot" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GhlSubaccountJobShot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GhlSubaccountJobShot_jobId_createdAt_idx" ON "GhlSubaccountJobShot"("jobId", "createdAt");

ALTER TABLE "GhlSubaccountJobShot" ADD CONSTRAINT "GhlSubaccountJobShot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GhlSubaccountJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
