-- Where a Hell-level number forwards the texts it receives (the owner's phone from onboarding).
ALTER TABLE "HlPhoneNumber" ADD COLUMN "forwardTextsTo" TEXT;
