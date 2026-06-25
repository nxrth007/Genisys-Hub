-- Paused leads — the "Pause Lead" master-tracker action records the
-- customer's normalized phone here; the reminder dispatcher skips
-- paused phones (held, not cancelled). Pure CREATE TABLE, safe.

CREATE TABLE "ReminderPause" (
    "id" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "pausedByUserId" TEXT,
    "pausedByName" TEXT,
    "pausedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderPause_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReminderPause_customerPhone_key" ON "ReminderPause"("customerPhone");
