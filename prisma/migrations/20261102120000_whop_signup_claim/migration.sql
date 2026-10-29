-- CreateTable (additive): one row per announced Whop membership; the primary key makes claiming atomic.
CREATE TABLE "WhopSignupClaim" (
    "membershipId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhopSignupClaim_pkey" PRIMARY KEY ("membershipId")
);
