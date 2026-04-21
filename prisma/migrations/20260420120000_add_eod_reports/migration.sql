-- End-of-day reports: one row per agent per shift day. Captures the metrics
-- Ethan asked for (dials, live contacts, appts generated) plus tech and
-- organizational issue tracking so friction patterns surface across days.
CREATE TABLE "EodReport" (
    "id" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "dialsMade" INTEGER NOT NULL DEFAULT 0,
    "contactsReached" INTEGER NOT NULL DEFAULT 0,
    "appointmentsGenerated" INTEGER NOT NULL DEFAULT 0,
    "callbacksScheduled" INTEGER NOT NULL DEFAULT 0,
    "technicalIssueTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "technicalIssueNotes" TEXT,
    "organizationalIssues" TEXT,
    "wins" TEXT,
    "tomorrowFocus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EodReport_pkey" PRIMARY KEY ("id")
);

-- One report per (agent, day). Agents PATCH to revise same-day submissions.
CREATE UNIQUE INDEX "EodReport_agentUserId_reportDate_key"
  ON "EodReport"("agentUserId", "reportDate");

CREATE INDEX "EodReport_reportDate_idx" ON "EodReport"("reportDate");

ALTER TABLE "EodReport" ADD CONSTRAINT "EodReport_agentUserId_fkey"
  FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
