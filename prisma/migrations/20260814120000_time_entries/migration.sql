-- Agent shift clock. clockOutAt NULL = shift still open.

CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "note" TEXT,
    "closedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TimeEntry_userId_clockInAt_idx" ON "TimeEntry"("userId", "clockInAt");
CREATE INDEX "TimeEntry_clockInAt_idx" ON "TimeEntry"("clockInAt");
CREATE INDEX "TimeEntry_clockOutAt_idx" ON "TimeEntry"("clockOutAt");

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
