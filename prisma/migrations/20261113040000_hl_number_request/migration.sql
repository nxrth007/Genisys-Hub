-- The GHL "number bank" job is gone: GHL wants each receiving sub-account's own
-- selfie/ID check before a number can be moved in. Its tables held one test run.
DROP TABLE "GhlNumberJobShot";
DROP TABLE "GhlNumberJob";

-- A client's Hell-level toll-free number, asked for in the Office (src/lib/hl/number-request.ts).
CREATE TABLE "HlNumberRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_approval',
    "forwardTo" TEXT,
    "numberId" TEXT,
    "number" TEXT,
    "verifyNote" TEXT,
    "verifyTriedAt" TIMESTAMP(3),
    "detail" TEXT,
    "log" JSONB,
    "trigger" TEXT NOT NULL DEFAULT 'onboarding',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HlNumberRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HlNumberRequest_clientId_key" ON "HlNumberRequest"("clientId");
CREATE INDEX "HlNumberRequest_status_idx" ON "HlNumberRequest"("status");

ALTER TABLE "HlNumberRequest" ADD CONSTRAINT "HlNumberRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
