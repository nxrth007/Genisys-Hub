-- Callbacks: agent's personal follow-up list. A callback is a prospect to
-- *call again later*, not a booked appointment. Per-agent, no staff rollup.
CREATE TABLE "Callback" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "callbackAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Callback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Callback_agentUserId_callbackAt_idx"
  ON "Callback"("agentUserId", "callbackAt");
CREATE INDEX "Callback_agentUserId_completedAt_idx"
  ON "Callback"("agentUserId", "completedAt");

ALTER TABLE "Callback" ADD CONSTRAINT "Callback_agentUserId_fkey"
  FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
