
-- AlterTable
ALTER TABLE "HlAppointment" ADD COLUMN     "assignedUserId" TEXT,
ADD COLUMN     "meta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "source" TEXT,
ADD COLUMN     "timezone" TEXT,
ADD COLUMN     "token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "HlAppointment_token_key" ON "HlAppointment"("token");

-- CreateIndex
CREATE INDEX "HlAppointment_assignedUserId_startTime_idx" ON "HlAppointment"("assignedUserId", "startTime");

