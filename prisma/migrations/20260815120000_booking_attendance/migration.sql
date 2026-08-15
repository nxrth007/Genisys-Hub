-- Attendance recorded in the CRM, keyed by GHL opportunity id.
-- Independent of whether a calendar appointment can be matched.

CREATE TABLE "BookingAttendance" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "subAccount" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "markedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingAttendance_opportunityId_key" ON "BookingAttendance"("opportunityId");
CREATE INDEX "BookingAttendance_subAccount_idx" ON "BookingAttendance"("subAccount");

ALTER TABLE "BookingAttendance" ADD CONSTRAINT "BookingAttendance_markedById_fkey"
    FOREIGN KEY ("markedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
